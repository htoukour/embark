const fs = require('./fs.js');
const ipc = require('node-ipc');
const os = require('os');
const {parse, stringify} = require('flatted/cjs');
const utils = require('../utils/utils');

class IPC {

  constructor(options) {
    this.logger = options.logger;
    this.socketPath = options.socketPath || IPC.provisionPath();
    this.ipcRole = options.ipcRole;
    ipc.config.silent = true;
    this.connected = false;
  }

  static provisionPath() {
    const ipcPointerPath = fs.dappPath('.embark/embark.ipc.pointer');
    if (fs.existsSync(ipcPointerPath)) {
      return fs.readFileSync(ipcPointerPath).toString().trim();
    } else {
      const ipcPath = utils.joinPath(fs.mkdtempSync(os.tmpdir()), 'embark.ipc');
      fs.mkdirpSync(fs.dappPath('.embark'));
      fs.writeFileSync(ipcPointerPath, ipcPath);
      return ipcPath;
    }
  }

  connect(done) {
    const self = this;
    function connecting(_socket) {
      let connectedBefore = false, alreadyDisconnected = false;
      ipc.of['embark'].on('connect',function() {
        connectedBefore = true;
        if (!alreadyDisconnected) {
          self.connected = true;
          done();
        }
      });
      ipc.of['embark'].on('disconnect',function() {
        self.connected = false;
        ipc.disconnect('embark');

        // we only want to trigger the error callback the first time
        if (!connectedBefore && !alreadyDisconnected) {
          alreadyDisconnected = true;
          done(new Error("no connection found"));
        }
      });
    }

    ipc.connectTo('embark', this.socketPath, connecting);
  }

  serve() {
    ipc.serve(this.socketPath, () => {});
    ipc.server.start();

    this.logger.info(`pid ${process.pid} listening on ${this.socketPath}`);
  }

  on(action, done) {
    const self = this;
    ipc.server.on('message', function(messageString, socket) {
      const message = parse(messageString);
      if (message.action !== action) {
        return;
      }
      let reply = function(error, replyData) {
        self.reply(socket, action, error, replyData);
      };
      done(message.data, reply, socket);
    });
  }

  reply(client, action, error, data) {
    const message = stringify({action, data, error: (error && error.stack)});
    ipc.server.emit(client, 'message', message);
  }

  listenTo(action, callback = () => {}) {
    if (!this.connected) {
      return callback();
    }
    ipc.of['embark'].on(action, (messageString) => {
      callback(parse(messageString));
    });
  }

  broadcast(action, data) {
    ipc.server.broadcast(action, stringify(data));
  }

  once(action, cb = () => {}) {
    if (!this.connected) {
      return cb();
    }
    ipc.of['embark'].once('message', function(messageString) {
      const message = parse(messageString);
      if (message.action !== action) {
        return;
      }
      cb(message.error, message.data);
    });
  }

  request(action, data, cb) {
    if (!this.connected) {
      cb = cb || (() => {});
      return cb();
    }
    if (cb) {
      this.once(action, cb);
    }
    ipc.of['embark'].emit('message', stringify({action: action, data: data}));
  }

  isClient() {
    return this.ipcRole === 'client';
  }

  isServer() {
    return this.ipcRole === 'server';
  }

}

module.exports = IPC;
