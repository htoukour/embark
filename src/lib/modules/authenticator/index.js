const uuid = require('uuid/v1');
const utils = require("../../utils/utils.js");
const keccak = require('keccakjs');

const ERROR_OBJ = {error: __('Wrong authentication token. Get your token from the Embark console by typing `token`')};

class Authenticator {
  constructor(embark, _options) {
    this.embark = embark;
    this.logger = embark.logger;
    this.events = embark.events;

    this.authToken = uuid();
    this.emittedTokens = {};

    this.registerCalls();
    this.registerEvents();
  }

  getRemoteAddress(req) {
    return req.headers['x-forwarded-for'] ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress;
  }

  generateRequestHash(req) {
    const remoteAddress = this.getRemoteAddress(req);
    const cnonce = req.headers['x-embark-cnonce'];

    // We fallback to the authToken in case of the firat authentication attempt.
    const token = this.emittedTokens[remoteAddress] || this.authToken;

    let url = req.url;
    const queryParamIndex = url.indexOf('?');
    url = url.substring(0, queryParamIndex !== -1 ? queryParamIndex : url.length);

    let hash = new keccak();
    hash.update(cnonce);
    hash.update(token);
    hash.update(req.method);
    hash.update(url);
    return hash.digest('hex');
  }

  registerCalls() {
    let self = this;

    this.embark.registerAPICall(
      'post',
      '/embark-api/authenticate',
      (req, res) => {
        let hash = self.generateRequestHash(req);
        if(hash !== req.headers['x-embark-request-hash']) {
          this.logger.warn(__('Someone tried and failed to authenticate to the backend'));
          this.logger.warn(__('- User-Agent: %s', req.headers['user-agent']));
          this.logger.warn(__('- Referer: %s', req.headers.referer));
          return res.send(ERROR_OBJ);
        }

        // Generate another authentication token.
        self.authToken = uuid();
        this.events.request('authenticator:displayUrl', false);

        // Register token for this connection, and send it through.
        const emittedToken = uuid();
        const remoteAddress = self.getRemoteAddress(req);
        this.emittedTokens[remoteAddress] = emittedToken;
        res.send({token: emittedToken});
      }
    );

    this.embark.registerConsoleCommand((cmd, _options) => {
      return {
        match: () => cmd === "token",
        process: (callback) => {
          utils.copyToClipboard(this.authToken);
          callback(null, __('Token copied to clipboard: %s', this.authToken));
        }
      };
    });
  }

  registerEvents() {
    let self = this;

    this.events.once('outputDone', () => {
      this.events.request('authenticator:displayUrl', true);
    });

    this.events.setCommandHandler('authenticator:displayUrl', (firstOutput) => {
      const {port, host, enabled} = this.embark.config.webServerConfig;

      if (enabled) {
        if(!firstOutput) this.logger.info(__('Previous token has now been used.'));
        this.logger.info(__('Access the web backend with the following url: %s',
          (`http://${host}:${port}/embark?token=${this.authToken}`.underline)));
      }
    });

    this.events.setCommandHandler('authenticator:authorize', (req, res, cb) => {
      let authenticated = false;
      if(!res.send) {
        const remoteAddress = self.getRemoteAddress(req);
        const authToken = this.emittedTokens[remoteAddress];

        authenticated = authToken !== undefined && authToken === req.protocol;
      } else {
        let hash = self.generateRequestHash(req);
        authenticated = (hash === req.headers['x-embark-request-hash']);
      }

      if(authenticated) return cb();
      cb(ERROR_OBJ);
    });
  }
}

module.exports = Authenticator;
