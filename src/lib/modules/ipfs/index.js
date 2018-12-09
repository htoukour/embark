const UploadIPFS = require('./upload.js');
const utils = require('../../utils/utils.js');
const fs = require('../../core/fs.js');
const IpfsApi = require('ipfs-api');
// TODO: not great, breaks module isolation
const StorageProcessesLauncher = require('../storage/storageProcessesLauncher');
const {canonicalHost} = require('../../utils/host');

class IPFS {

  constructor(embark, options) {
    const self = this;
    this.logger = embark.logger;
    this.events = embark.events;
    this.buildDir = options.buildDir;
    this.storageConfig = embark.config.storageConfig;
    this.namesystemConfig = embark.config.namesystemConfig;
    this.embark = embark;

    this.webServerConfig = embark.config.webServerConfig;
    this.blockchainConfig = embark.config.blockchainConfig;

    if (this.isIpfsStorageEnabledInTheConfig()) {
      this.downloadIpfsApi();
      this.setServiceCheck();
      this.addStorageProviderToEmbarkJS();
      this.addObjectToConsole();
      this.registerUploadCommand();

      this.events.request("processes:register", "ipfs", (cb) => {
        self.startProcess(cb);
      });

      this._checkService((err) => {
        if (!err) {
          return;
        }
        self.logger.info("IPFS node not found, attempting to start own node");
        this.listenToCommands();
        this.registerConsoleCommands();
        this.events.request('processes:launch', 'ipfs');
      });
    }
  }

  downloadIpfsApi() {
    const self = this;

    self.events.request("version:get:ipfs-api", function(ipfsApiVersion) {
      let currentIpfsApiVersion = require('../../../../package.json').dependencies["ipfs-api"];
      if (ipfsApiVersion !== currentIpfsApiVersion) {
        self.events.request("version:getPackageLocation", "ipfs-api", ipfsApiVersion, function(err, location) {
          self.embark.registerImportFile("ipfs-api", fs.dappPath(location));
        });
      }
    });
  }

  setServiceCheck() {
    let self = this;

    self.events.on('check:backOnline:IPFS', function () {
      self.logger.info(__('IPFS node detected') + '..');
    });

    self.events.on('check:wentOffline:IPFS', function () {
      self.logger.info(__('IPFS node is offline') + '..');
    });

    self.events.request("services:register", 'IPFS', function (cb) {
      self._checkService(true, (err, body) => {
        if (err) {
          self.logger.trace("IPFS unavailable");
          return cb({name: "IPFS ", status: 'off'});
        }
        if (body.Version) {
          self.logger.trace("IPFS available");
          return cb({name: ("IPFS " + body.Version), status: 'on'});
        }
        self.logger.trace("IPFS available");
        return cb({name: "IPFS ", status: 'on'});
      });
    });
  }

  _getNodeConfig() {
    if (this.storageConfig.upload.provider === 'ipfs') {
      return this.storageConfig.upload;
    }

    for (let connection of this.storageConfig.dappConnection) {
      if (connection.provider === 'ipfs') {
        return connection;
      }
    }
  }

  _checkService(getJson, cb) {
    let _cb = cb || function () {};
    let _getJson = getJson;
    if (typeof getJson === 'function') {
      _cb = getJson;
      _getJson = false;
    }
    const cfg = this._getNodeConfig();
    utils.pingEndpoint(
      canonicalHost(cfg.host),
      cfg.port,
      false,
      cfg.protocol === 'https' ? cfg.protocol : 'http',
      utils.buildUrlFromConfig(cfg),
      (err) => {
        if (err) {
          _cb(err);
        } else if (_getJson) {
          utils.getJson(utils.buildUrlFromConfig(cfg) + '/api/v0/version', _cb);
        } else {
          _cb();
        }
      }
    );
  }

  addStorageProviderToEmbarkJS() {
    let code = "";
    code += "\n" + fs.readFileSync(utils.joinPath(__dirname, 'embarkjs.js')).toString();
    code += "\nEmbarkJS.Storage.registerProvider('ipfs', __embarkIPFS);";

    this.embark.addCodeToEmbarkJS(code);
  }

  addObjectToConsole() {
    let ipfs = IpfsApi(this.host, this.port);
    this.events.emit("runcode:register", "ipfs", ipfs);
  }

  startProcess(callback) {
    let self = this;
    const storageProcessesLauncher = new StorageProcessesLauncher({
      logger: self.logger,
      events: self.events,
      storageConfig: self.storageConfig,
      webServerConfig: self.webServerConfig,
      blockchainConfig: self.blockchainConfig,
      corsParts: self.embark.config.corsParts,
      embark: self.embark
    });
    self.logger.trace(`Storage module: Launching ipfs process...`);
    return storageProcessesLauncher.launchProcess('ipfs', callback);
  }

  registerUploadCommand() {
    const self = this;
    this.embark.registerUploadCommand('ipfs', (cb) => {
      let upload_ipfs = new UploadIPFS({
        buildDir: self.buildDir || 'dist/',
        storageConfig: self.storageConfig,
        configIpfsBin: self.storageConfig.ipfs_bin || "ipfs",
        env: this.embark.env
      });

      upload_ipfs.deploy(cb);
    });
  }

  listenToCommands() {
    this.events.setCommandHandler('logs:ipfs:turnOn',  (cb) => {
      this.events.emit('logs:storage:enable');
      return cb(null, 'Enabling IPFS logs');
    });

    this.events.setCommandHandler('logs:ipfs:turnOff',  (cb) => {
      this.events.emit('logs:storage:disable');
      return cb(null, 'Disabling IPFS logs');
    });
  }

  registerConsoleCommands() {
    const self = this;
    self.embark.registerConsoleCommand((cmd, _options) => {
      return {
        match: () => cmd === 'log ipfs on',
        process: (cb) => self.events.request('logs:ipfs:turnOn', cb)
      };
    });

    self.embark.registerConsoleCommand((cmd, _options) => {
      return {
        match: () => cmd === 'log ipfs off',
        process: (cb) => self.events.request('logs:ipfs:turnOff', cb)
      };
    });
  }

  isIpfsStorageEnabledInTheConfig() {
    let {enabled, available_providers, dappConnection} = this.storageConfig;
    return enabled && (available_providers.indexOf('ipfs') > 0 || dappConnection.find(c => c.provider === 'ipfs'));
  }
}

module.exports = IPFS;
