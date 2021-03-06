const fs = require("fs");
const grpc = require("grpc");
const path = require("path");
const { spawn } = require("child_process");
const Exec = require("./Exec");
const baseLogger = require("../utils/logger");
const rmrf = require("rimraf");
const registerIpc = require("electron-ipc-tunnel/server").default;
const { ipcSend, isPortTaken, noExponents } = require("../utils/helpers");
const settings = require("../settings");

const LND_ERRORS = ["2 UNKNOWN:", "102 undefined:", "103 undefined:", "101 undefined:", "14 UNAVAILABLE:"];
const logger = baseLogger.child("binaries");
const LND_DEFAULT_RPC_PORT = 10009;
const LND_DEFAULT_REST_PORT = 8080;
const lnRpcDescriptor = grpc.load({
    file: "rpc.proto",
    root: path.join(__dirname, "proto"),
});

const localLndRpcIp = `127.0.0.1:${settings.get.lnd.rpclisten}`;
const LND_CONF_FILE = "lnd.conf";
const LND_CERT_FILE = "tls.cert";
const LND_KEY_FILE = "tls.key";
const MACAROON_FILE = "admin.macaroon";
const READONLY_MACAROON_FILE = "readonly.macaroon";

process.env.GRPC_SSL_CIPHER_SUITES = "HIGH+ECDSA";

// in seconds
const GRPC_DEADLINE = 60;

/**
 * set Rpc timeout deadline.
 * @param {number} deadline
 * @return {number} - Deadline, current time + deadline
 */
const getDeadLine = (deadline = GRPC_DEADLINE) => {
    const deadLine = new Date();
    return deadLine.setSeconds(deadLine.getSeconds() + deadline);
};

const getMacaroonMeta = (name) => {
    const macaroonFile = path.join(settings.get.dataPath, name, MACAROON_FILE);
    const metadata = new grpc.Metadata();
    const macaroonHex = fs.readFileSync(macaroonFile).toString("hex");
    metadata.add("macaroon", macaroonHex);
    return metadata;
};

/**
 * Get WalletUnlocker or Lightning rpc service
 * @param {string} name
 * @param {string}[service=WalletUnlocker|Lightning] service
 * @return {Promise<void>}
 */
const getRpcService = async (name, service) => new Promise((resolve, reject) => {
    const certPath = path.join(settings.get.dataPath, name, LND_CERT_FILE);
    const sslCreds = grpc.credentials.createSsl(fs.readFileSync(certPath));
    const client = new lnRpcDescriptor.lnrpc[service](localLndRpcIp, sslCreds);
    logger.info({ func: getRpcService }, `Will start waiting for grpc connection with params: ${name}, ${service}`);
    ipcSend("setLndInitStatus", `Wait for ${service} service in LND`);
    grpc.waitForClientReady(client, Infinity, (err) => {
        if (err) {
            logger.error({ func: getRpcService }, err);
            reject(err);
        }
        if (service === "Lightning" && !settings.get.lnd.no_macaroons) {
            resolve({ client, metadata: getMacaroonMeta(name) });
        }
        resolve(client);
    });
});

let lastError;

/**
 * Wait until lnd autogenerate certs
 * @param {string} name
 * @return {Promise<any>}
 */
const awaitTlsGen = async name => new Promise((resolve) => {
    const intervalId = setInterval(() => {
        if (fs.existsSync(path.join(settings.get.dataPath, name, LND_CERT_FILE))) {
            clearInterval(intervalId);
            resolve();
        }
    }, 500);
});

const isLndPortsAvailable = async (peerPort) => {
    const rpcPort = settings.get.lnd.rpclisten ? settings.get.lnd.rpclisten : LND_DEFAULT_RPC_PORT;
    const restPort = settings.get.lnd.restlisten ? settings.get.lnd.restlisten : LND_DEFAULT_REST_PORT;
    try {
        const peerPortListen = await isPortTaken(peerPort, "0.0.0.0");
        const rpcPortListen = await isPortTaken(rpcPort, "127.0.0.1");
        const restPortListen = await isPortTaken(restPort, "127.0.0.1");
        const portErrors = [];
        if (!peerPortListen) {
            portErrors.push(peerPort);
        }
        if (!rpcPortListen) {
            portErrors.push(rpcPort);
        }
        if (!restPortListen) {
            portErrors.push(restPort);
        }
        const error = `${portErrors.join(", ")} 
        ${portErrors.length > 1 ? "ports" : "port"} is used by some app. Free it before using wallet`;
        return { ok: peerPortListen && rpcPortListen && restPortListen, error, type: "port" };
    } catch (e) {
        return { ok: false, error: e.message, type: "internal" };
    }
};

const getLogLevel = () => {
    const availableLevels = ["trace", "debug", "info", "warn", "error", "critical"];
    const level = String(settings.get.lnd.log_level);
    if (!availableLevels.includes(level)) {
        return availableLevels[2];
    }
    return level;
};

let singleton = null;

class Lnd extends Exec {
    constructor() {
        super();
        if (!singleton) {
            singleton = this;
        } else {
            return singleton;
        }
        this.process_name = "Lnd";
        this.name = "";
        this.pid_name = "lnd_pid.json";
        this.pid = this._getPid();
        this.starting = false;

        this._unlocker = null;
        this._client = null;
        this._metadata = null;

        this._bitcoinMeasure = null;
        this.shoudClearData = false;
        this._peerPort = null;

        this._registerListener();
    }

    async validateBeforeStart() {
        try {
            if (!fs.existsSync(settings.get.binariesLndPath)) {
                return { ok: false, error: "LND binary not found" };
            }
            const isFreePorts = await isLndPortsAvailable(this._peerPort);
            if (!isFreePorts.ok) {
                this.starting = false;
                return isFreePorts;
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message, type: "internal" };
        }
    }

    /**
     * Subscribe to changes bitcoin measure from frontend
     * @private
     */
    _registerListener() {
        registerIpc("set-bitcoin-measure", (event, arg) => {
            this._bitcoinMeasure = {
                type: arg.type,
                multiplier: arg.multiplier,
                toFixed: arg.toFixed,
            };
        });
        registerIpc("set-should-clear-data", (event, arg) => {
            this.shoudClearData = arg.clearData;
        });
    }

    /**
     * Lightning rpc call
     * @param {string} method
     * @param {object} [args={}]
     * @param {null|number} [deadLine=]
     * @param {function} [cb=] Callback
     * @return {undefined|Promise<any>}
     */
    call(method, args = {}, deadLine = GRPC_DEADLINE, cb = null) {
        const logArgs = Object.assign({}, args);
        delete logArgs.wallet_password;
        logger.debug("[LND] Call: ", { method, args: logArgs });
        let timeout = parseInt(deadLine, 10);
        timeout = Number.isNaN(timeout) ? GRPC_DEADLINE : timeout;
        const dateDeadLine = getDeadLine(timeout < 1 ? GRPC_DEADLINE : timeout);
        if (cb) {
            const response = this._client[method](args, { deadline: dateDeadLine }, cb);
            logger.debug("[LND] Response (no-callback): ", { Method: method, response });
            return undefined;
        }
        return new Promise((resolve) => {
            try {
                const params = [{ deadline: dateDeadLine }];
                if (!settings.get.lnd.no_macaroons) {
                    params.unshift(this._metadata);
                }
                this._client[method](args, ...params, (err, response) => {
                    if (err) {
                        logger.error(method, args, err);
                        const error = this.prettifyMessage(err.message);
                        resolve(Object.assign({ ok: false }, err, { error }));
                    }
                    logger.debug("[LND] Response: ", { method, args: logArgs, response });
                    resolve(Object.assign({ ok: true }, { response }));
                });
            } catch (err) {
                logger.error(method, args, err);
                const error = this.prettifyMessage(err.message);
                resolve(Object.assign({ ok: false }, err, { error }));
            }
        });
    }

    /**
     * Lightning stream rpc call
     * @param {string} method
     * @param {object} [args={}]
     * @return {*}
     */
    streamCall(method, args = {}) {
        let response;
        logger.debug("[LND] Call: ", { method, args });
        try {
            if (method === "sendPayment") {
                response = !settings.get.lnd.no_macaroons ?
                    this._client[method](this._metadata, args) :
                    this._client[method](args);
                logger.debug("[LND] Response: ", { method, args, response });
                return ({
                    ok: true,
                    stream: response,
                });
            }
            response = !settings.get.lnd.no_macaroons ?
                this._client[method](args, this._metadata) :
                this._client[method](args);
            logger.debug("[LND] Response: ", { method, args, response });
            return ({
                ok: true,
                stream: response,
            });
            // return ({ ok: true, stream: this._client[method](args) });
        } catch (err) {
            logger.error(method, args, err);
            return Object.assign({ ok: false }, err, { error: this.prettifyMessage(err.message) });
        }
    }

    /**
     * Options for lnd starting
     * @return {*[]}
     */
    getOptions() {
        const options = [
            "--lnddir", path.join(settings.get.dataPath, this.name),
            "--configfile", path.join(settings.get.dataPath, this.name, LND_CONF_FILE),
            "--datadir", path.join(settings.get.dataPath, this.name, "data"),
            "--tlscertpath", path.join(settings.get.dataPath, this.name, LND_CERT_FILE),
            "--tlskeypath", path.join(settings.get.dataPath, this.name, LND_KEY_FILE),
            "--logdir", path.join(settings.get.dataPath, this.name, "log"),
            "--debuglevel", getLogLevel(),
            "--bitcoin.node", settings.get.bitcoin.node,
            "--listen", `0.0.0.0:${this._peerPort}`,
        ];
        if (settings.get.lnd) {
            if (settings.get.lnd.rpclisten) {
                options.push("--rpclisten", `127.0.0.1:${settings.get.lnd.rpclisten}`);
            }
            if (settings.get.lnd.restlisten) {
                options.push("--restlisten", `127.0.0.1:${settings.get.lnd.restlisten}`);
            }
        }
        if (!settings.get.lnd.no_macaroons) {
            options.push(
                "--adminmacaroonpath", path.join(settings.get.dataPath, this.name, MACAROON_FILE),
                "--readonlymacaroonpath", path.join(settings.get.dataPath, this.name, READONLY_MACAROON_FILE),
            );
        } else {
            options.push("--no-macaroons");
        }
        if (settings.get.bitcoin.active) {
            options.push("--bitcoin.active");
        }
        if (settings.get.bitcoin.network === "testnet") {
            options.push("--bitcoin.testnet");
        } else if (settings.get.bitcoin.network === "simnet") {
            options.push("--bitcoin.simnet");
        } else if (settings.get.bitcoin.network === "mainnet") {
            options.push("--bitcoin.mainnet");
        } else {
            options.push("--bitcoin.regtest");
        }
        if (settings.get.bitcoin.node === "neutrino") {
            options.push("--neutrino.connect", settings.get.neutrino.connect);
        } else if (settings.get.bitcoin.node === "btcd") {
            options.push(
                "--btcd.rpcuser", settings.get.btcd.rpcuser,
                "--btcd.rpcpass", settings.get.btcd.rpcpass,
                "--btcd.rpchost", settings.get.btcd.rpchost,
                "--btcd.rpccert", settings.get.btcd.rpccert,
            );
        }
        if (settings.get.autopilot.active) {
            options.push("--autopilot.active");
        }
        return options;
    }

    /**
     * Start lnd
     * @param {string} name
     * @return {Promise<*>}
     */
    async start(name) {
        if (!name) {
            const error = "No name for LND given";
            logger.error({ func: this.start }, error);
            return { ok: false, error };
        }
        if (this.starting) {
            const error = "LND has been started already";
            logger.error({ func: this.start }, error);
            return { ok: false, error };
        }
        this.name = name;
        this.manualStopped = false;
        this._peerPort = settings.get.listenPort(this.name);
        if (this.pid !== -1) {
            this.stop();
        }

        return this._startLnd();
    }

    /**
     * Clear lnd folder
     * @return {*}
     * @private
     */
    _clearData() {
        return new Promise((resolve) => {
            if (!this.name) {
                const error = "No name for LND given";
                logger.error({ func: this.clearData }, error);
                resolve({ ok: false, error });
                return;
            }

            rmrf(path.join(settings.get.dataPath, this.name), (err) => {
                if (err) {
                    logger.error({ func: this.clearData }, err);
                    resolve({ ok: false, error: err.message });
                }
                resolve({ ok: true });
            });
        });
    }

    /**
     * Run lnd, set WalletUnlocker rpc service
     * @return {Promise<*>}
     * @private
     */
    async _startLnd() {
        this.starting = true;
        const validStartup = await this.validateBeforeStart();
        if (!validStartup.ok) {
            this.starting = false;
            return validStartup;
        }
        logger.info("Will start lnd with params: \n", this.getOptions().join(" "));
        ipcSend("setLndInitStatus", "Lnd prepare to start");
        try {
            // Start Lnd
            const lnd = spawn(settings.get.binariesLndPath, this.getOptions(), { detached: true });
            lnd.stdout.on("data", (data) => {
                console.log(`LND stdout: ${data}`);
            });
            lnd.stderr.on("data", (data) => {
                logger.error({ func: this._startLnd }, "LND stderr: ", data.toString());
                lastError = data.toString();
            });
            lnd.on("exit", (code, signal) => {
                ipcSend("lnd-down", lastError);
                if (lastError) {
                    ipcSend("setLndInitStatus", lastError);
                }
                this.handleExit(code, signal);
            });
            this._savePid(lnd.pid);
        } catch (err) {
            this.starting = false;
            logger.error({ func: this._startLnd }, "Error while running LND: ", err);
            return {
                ok: false,
                error: err.message,
            };
        }

        // wait for cert generating
        await awaitTlsGen(this.name);
        try {
            logger.debug("[LND] Init grpc WalletUnlock");
            this._client = await getRpcService(this.name, "WalletUnlocker");
            settings.set("lndPeer", [this.name, this._peerPort]);
            return { ok: true };
        } catch (err) {
            logger.error({ func: this._startLnd }, "Error while unlock/create LND: ", err);
            return {
                ok: false,
                error: err.message,
            };
        }
    }

    /**
     * @param {string} password - Password
     * @param {array} [seed=] - Array of seed words
     * @param {boolean} [recovery=false] - Try to recover wallet from seed and pass
     * @returns {Promise<*>}
     */
    async createWallet(password, seed, recovery = false) {
        const params = { wallet_password: Buffer.from(password, "binary") };
        if (seed) {
            params.cipher_seed_mnemonic = seed;
        }
        if (recovery) {
            params.recovery_window = parseInt(settings.get.lnd.address_look_ahead, 10);
        }
        ipcSend("setLndInitStatus", "Creating wallet in LND");
        let response = await this.call("initWallet", params);
        if (!response.ok) {
            logger.error(response.message);
            return response;
        }
        response = await this._initWallet();
        return response;
    }

    async unlockWallet(password) {
        ipcSend("setLndInitStatus", "Unlocking wallet in LND");
        let response = await this.call("unlockWallet", { wallet_password: Buffer.from(password, "binary") });
        if (!response.ok) {
            logger.error(response.message);
            ipcSend("setLndInitStatus", "");
            return response;
        }
        response = await this._initWallet();
        return response;
    }

    async _initWallet() {
        // Get Lightning rpc service
        logger.debug("[LND] Init grpc Lightning");
        const service = await getRpcService(this.name, "Lightning");
        if (!settings.get.lnd.no_macaroons) {
            this._client = service.client;
            this._metadata = service.metadata;
        } else {
            this._client = service;
        }
        // Sometimes rpc client start before lnd ready to accept rpc calls, let's wait
        const getInfo = await this._waitRpcAvailability();
        this.starting = false;
        return getInfo;
    }

    /**
     * wait until rpc service will be available
     * @returns {Promise}
     * @private
     */
    async _waitRpcAvailability() {
        return new Promise((resolve) => {
            const intervalId = setInterval(async () => {
                const response = await this.call("getInfo");
                if (response.ok) {
                    clearInterval(intervalId);
                    resolve(response);
                } else {
                    logger.debug("[LND] Waiting grpc Lightning");
                    this._client = await getRpcService(this.name, "Lightning");
                }
            }, 1000);
        });
    }

    /**
     * @param {string} msg
     */
    checkAvailablity(msg) {
        const notAvailable = (
            msg.toLowerCase().includes("unavailable") ||
            msg.toLowerCase().includes("connect failed") ||
            msg.toLowerCase().includes("the client has been shutdown")
        );
        if (notAvailable) {
            ipcSend("forceLogout", msg);
        }
    }

    /**
     * @param {string} msg
     * @return {string}
     */
    prettifyMessage(msg) {
        // const ERRORS = [/not enought witness outputs to create funding transaction/i];
        const convertBtcToSatoshi = value => Math.round(parseFloat(value) / 1e-8);
        const convertMSatToSatoshi = value => Math.round(parseFloat(value) * 1e-3);
        const convertToCurrent = (value, type = "BTC") => {
            let amount;
            if (type === "mSAT") {
                amount = convertMSatToSatoshi(value);
            } else {
                amount = convertBtcToSatoshi(value);
            }
            const num = (amount * this._bitcoinMeasure.multiplier);
            return noExponents(parseFloat(num.toFixed(this._bitcoinMeasure.toFixed)));
        };
        let newMsg = `[LND_ERROR]: ${msg}`;
        LND_ERRORS.forEach((item) => {
            newMsg = newMsg.replace(item, "");
        });
        newMsg = newMsg.trim();
        newMsg = newMsg.replace(/[0-9.]+\s*(BTC|mSAT)/igm, (item) => {
            const [a, m] = item.split(" ");
            if (m === this._bitcoinMeasure.type) {
                return item;
            }
            if (m === "BTC") {
                return `${convertToCurrent(a)} ${this._bitcoinMeasure.type}`;
            }
            if (m === "mSAT") {
                return `${convertToCurrent(a, m)} ${this._bitcoinMeasure.type}`;
            }
            return item;
        });
        this.checkAvailablity(newMsg);
        return newMsg;
    }
}

module.exports = Lnd;
