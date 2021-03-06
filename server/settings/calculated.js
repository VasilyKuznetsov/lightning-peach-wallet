const fs = require("fs");
const { join } = require("path");
const helpers = require("../utils/helpers");
const baseLogger = require("../utils/logger");

const logger = baseLogger.child("electron");

module.exports = ({
    appPath,
    dataPath,
    baseSettings,
    config,
}) => {
    const peersFile = join(config.get("dataPath"), "peers.json");
    /**
     * Return username based path to database file
     * @param {*} username
     * @returns {*}
     */
    const databasePath = username => join(config.get("dataPath"), String(username), config.get("backend.dbFile"));

    /**
     * Create agreement file (eula.txt and google analytics agreement)
     * @param {bool} gaChecked - if user agreed to send ga analytics
     */
    const setAgreement = async (gaChecked) => {
        logger.info("[SETTINGS] - setAgreement", gaChecked);
        const sendStatistics = gaChecked || false;
        const agreementContent = [
            "[agreement]",
            "eula = true",
            `sendStatistics = ${sendStatistics}`,
        ];
        if (gaChecked) {
            agreementContent.push(
                "",
                "[analytics]",
                `trackingID = ${baseSettings.peachSettings.analytics.trackingID}`,
                `appUrl = ${baseSettings.peachSettings.analytics.appUrl}`,
            );
        }
        logger.info("[SETTINGS] - will write ", agreementContent);
        await helpers.writeFile(join(dataPath, "agreement.ini"), agreementContent.join("\n"));
        config.set("analytics", Object.assign({}, baseSettings.peachSettings.analytics));
        config.set("agreement", { eula: true, sendStatistics });
    };

    const walletLndPath = (name, additionalFile) => {
        if (!name) {
            throw new Error("Username for wallet not provided");
        }
        const paths = [config.get("dataPath"), String(name)];
        if (additionalFile) {
            paths.push(String(additionalFile));
        }
        return join(...paths);
    };

    const listenPort = (username) => {
        const fileExists = fs.existsSync(peersFile);
        if (!fileExists) {
            logger.info("[SETTINGS] - listenPort", { fileExists, username, port: config.get("lnd.init_listen") });
            return config.get("lnd.init_listen");
        }
        const peers = JSON.parse(fs.readFileSync(peersFile).toString());
        logger.info("[SETTINGS] - listenPort", { fileExists, username, peers });
        if (username in peers) {
            return peers[username];
        }
        const lndPeer = Math.max(...Object.values(peers));
        logger.info("[SETTINGS] - listenPort", { fileExists, username, lndPeer });
        return parseInt(lndPeer, 10) + 1;
    };

    const setListenPort = async (username, port) => {
        const initPort = config.get("lnd.init_listen");
        const parsedPort = parseInt(port, 10);
        if (parsedPort < initPort) {
            throw new Error(`Port must be greater than ${initPort}`);
        }
        const fileExists = fs.existsSync(peersFile);
        logger.info("[SETTINGS] - setListenPort", {
            initPort, parsedPort, peersFile, fileExists, username,
        });
        if (!fileExists) {
            await helpers.writeFile(peersFile, JSON.stringify({ [username]: parsedPort }));
            return;
        }
        helpers.ipcSend("setPeerPort", parsedPort);
        const peers = JSON.parse(fs.readFileSync(peersFile).toString());
        logger.info("[SETTINGS] - setListenPort", { peers });
        if (username in peers && peers[username] === parsedPort) {
            return;
        }
        peers[username] = parsedPort;
        await helpers.writeFile(peersFile, JSON.stringify(peers));
    };

    return {
        databasePath,
        listenPort,
        setAgreement,
        setListenPort,
        walletLndPath,
    };
};
