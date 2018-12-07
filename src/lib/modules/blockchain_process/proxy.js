/* global Buffer __ exports require */

const Asm = require('stream-json/Assembler');
const {Transform} = require('stream');
const {canonicalHost, defaultHost} = require('../../utils/host');
const {chain}  = require('stream-chain');
const cloneable = require('cloneable-readable');
const constants = require('../../constants.json');
const express = require('express');
const {parser} = require('stream-json');
// const wsIncoming = require('../../../../node_modules/http-proxy/lib/http-proxy/passes/ws-incoming');
// const proxyHttp = require.resolve('http-proxy', {paths: ['./node_modules/http-proxy-middleware/node_modules']});
// console.log(wsIncoming);
require('./httpProxyOverride');
const proxyMiddleware = require('http-proxy-middleware');
const pump = require('pump');
const utils = require('../../utils/utils');
const WebSocket = require('ws');
const WsParser = require('simples/lib/parsers/ws');

const METHODS_TO_MODIFY = {accounts: 'eth_accounts'};
const hex = (n) => {
  let _n = n.toString(16);
  return _n.length === 1 ? '0' + _n : _n;
};

const parseJsonMaybe = (string) => {
  let object;
  if (typeof string === 'string') {
    if (string) {
      try {
        object = JSON.parse(string);
      } catch(e) {
        if (Array.from(Buffer.from(string)).map(hex).join(':') !==
            '03:ef:bf:bd') {
          console.error(`Proxy: Error parsing string as JSON '${string}'`);
        }
      }
    } else {
      console.error('Proxy: Expected a non-empty string');
    }
  } else {
    console.error(`Proxy: Expected a string but got type '${typeof string}'`);
  }
  return object;
};

exports.serve = async (ipc, host, port, ws, origin, accounts) => {
  const commList = {};
  const receipts = {};
  const transactions = {};
  const toModifyPayloads = {};

  const trackRequest = (req) => {
    if (!req) return;
    try {
      if (Object.values(METHODS_TO_MODIFY).includes(req.method)) {
        toModifyPayloads[req.id] = req.method;
      }
      if (req.method === 'eth_sendTransaction') {
        commList[req.id] = {
          type: 'contract-log',
          address: req.params[0].to,
          data: req.params[0].data
        };
      } else if (req.method === 'eth_getTransactionReceipt') {
        if (transactions[req.params[0]]) {
          transactions[req.params[0]].receiptId = req.id;
          receipts[req.id] = transactions[req.params[0]].commListId;
        }
      }
    } catch (e) {
      console.error(
        `Proxy: Error tracking request message '${JSON.stringify(req)}'`,
      );
    }
  };

  const trackResponse = (res) => {
    if (!res) return;
    try {
      if (commList[res.id]) {
        commList[res.id].transactionHash = res.result;
        transactions[res.result] = {commListId: res.id};
      } else if (receipts[res.id] && res.result && res.result.blockNumber) {
        // TODO find out why commList[receipts[res.id]] is sometimes not defined
        if (!commList[receipts[res.id]]) {
          commList[receipts[res.id]] = {};
        }
        commList[receipts[res.id]].blockNumber = res.result.blockNumber;
        commList[receipts[res.id]].gasUsed = res.result.gasUsed;
        commList[receipts[res.id]].status = res.result.status;

        if (ipc.connected && !ipc.connecting) {
          ipc.request('log', commList[receipts[res.id]]);
        } else {
          const message = commList[receipts[res.id]];
          ipc.connecting = true;
          ipc.connect(() => {
            ipc.connecting = false;
            ipc.request('log', message);
          });
        }
        delete transactions[commList[receipts[res.id]].transactionHash];
        delete commList[receipts[res.id]];
        delete receipts[res.id];
      }
    } catch (e) {
      console.error(
        `Proxy: Error tracking response message '${JSON.stringify(res)}'`
      );
    }
  };

  const start = Date.now();
  await (function waitOnTarget() {
    return new Promise(resolve => {
      utils.pingEndpoint(
        canonicalHost(host),
        port,
        ws ? 'ws': false,
        'http',
        origin ? origin.split(',')[0] : undefined,
        (err) => {
          if (!err || (Date.now() - start > 10000)) {
            resolve();
          } else {
            utils.timer(250).then(waitOnTarget).then(resolve);
          }
        }
      );
    });
  }());

  const proxyOpts = {
    logLevel: 'warn',
    target: `http://${canonicalHost(host)}:${port}`,
    ws: ws,

    onError(err, _req, _res) {
      console.error(
        __('Proxy: Error forwarding requests to blockchain/simulator'),
        err.message
      );
    },
    createWsServerTransformStream: function(_req, _proxyReq, _proxyRes) {
      const recv = new WebSocket.Receiver();
      // recv.on('message', (data) => {
      //   const object = parseJsonMaybe(data);
      //   console.log(object);
      // });
      // pump(cloneable(_proxyRes), recv);
      let cb;
      recv.on('message', (data) => {
        cb(null, Buffer.from(data));
      });
      return new Transform({
        transform(chunk, encoding, callback) {
          cb = callback;
          recv.write(chunk);


          // const chunkString = chunk.toString();
          // try {
          //   const index = chunkString.indexOf("{");
          //   const data = JSON.parse(chunkString.toString('utf8').substr(index));
          //   if (toModifyPayloads[data.id]) {
          //     console.error('Accounts', chunkString);
          //     data.result = data.result.concat(accounts);
          //     chunk = JSON.stringify(data);
          //     return callback(null, chunk);
          //   }
          //   // if (toModifyPayloads[data.id]) {
          //   //   const chunk2 = chunk.toString('utf8').replace('0x00a329c0648769a73afac7f9381e08fb43dbea72', '0xb8d851486d1c953e31a44374aca11151d49b8bb3');
          //   //   console.log('Modify this', chunk2);
          //   //   const newAccounts = data.result.concat(accounts);
          //   //   console.log(newAccounts);
          //   //   data.result = newAccounts;
          //   //   // const str = chunk.toString('utf8').substr(0, index - 1) + JSON.stringify(data);
          //   //   chunk = JSON.stringify(data);
          //   //   // chunk = chunk.toString('utf8').substr(0, index - 1) + JSON.stringify(data);
          //   //   delete toModifyPayloads[data.id];
          //   //   // this.push(Buffer.from(chunk2, 'utf8'));
          //   //   // return callback(null, Buffer.from(chunk2, 'utf8'));
          //   // }
          // } catch (e) {
          //   console.error('error:', chunkString);
          //   // console.trace(e);
          // }


          // this.push(chunk);
          // callback();
        }
      });
    },

    onProxyReq(_proxyReq, req, _res) {
      if (req.method === 'POST') {
        // messages TO the target
        Asm.connectTo(chain([
          req,
          parser()
        ])).on('done', ({current: object}) => {
          trackRequest(object);
        });
      }
    },

    onProxyRes(proxyRes, req, _res) {
      if (req.method === 'POST') {
        // messages FROM the target
        Asm.connectTo(chain([
          proxyRes,
          parser()
        ])).on('done', ({current: object}) => {
          trackResponse(object);
        });
      }
    }
  };

  if (ws) {
    proxyOpts.onProxyReqWs = (_proxyReq, _req, socket, _options, _head) => {
      // messages TO the target
      const wsp = new WsParser(0, false);
      wsp.on('frame', ({data: buffer}) => {
        const object = parseJsonMaybe(buffer.toString());
        trackRequest(object);
      });
      pump(cloneable(socket), wsp);
    };

    proxyOpts.onOpen = (proxySocket) => {
      // messages FROM the target
      const recv = new WebSocket.Receiver();
      recv.on('message', (data) => {
        const object = parseJsonMaybe(data);
        trackResponse(object);
      });
      pump(cloneable(proxySocket), recv);
    };
  }

  const proxy = proxyMiddleware(proxyOpts);
  const app = express();
  app.use('*', proxy);

  return new Promise(resolve => {
    const server = app.listen(
      port - constants.blockchain.servicePortOnProxy,
      defaultHost,
      () => { resolve(server); }
    );
    if (ws) {
      server.on('upgrade', proxy.upgrade);
    }
  });
};
