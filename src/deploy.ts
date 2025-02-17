import FTPS from "ftps";
import fs from "fs";
import { IFileList, IDiff, syncFileDescription, currentSyncFileVersion, IFtpDeployArgumentsWithDefaults } from "./types";
import { HashDiff } from "./HashDiff";
import { ILogger, retryRequest, ITimings, applyExcludeFilter, formatNumber } from "./utilities";
import prettyBytes from "pretty-bytes";
import { prettyError } from "./errorHandling";
import { ensureDir, FTPSyncProvider } from "./syncProvider";
import { getLocalFiles } from "./localFiles";

async function downloadFileList(client: FTPS, logger: ILogger, path: string): Promise<IFileList> {
    // note: originally this was using a writable stream instead of a buffer file
    // basic-ftp doesn't seam to close the connection when using steams over some ftps connections. This appears to be dependent on the ftp server
    const tempFileNameHack = ".ftp-deploy-sync-server-state-buffer-file---delete.json";

    await retryRequest(logger, async () => await client.getFile(tempFileNameHack, path).exec(console.log));

    const fileAsString = fs.readFileSync(tempFileNameHack, { encoding: "utf-8" });
    const fileAsObject = JSON.parse(fileAsString) as IFileList;

    fs.unlinkSync(tempFileNameHack);

    return fileAsObject;
}

function createLocalState(localFiles: IFileList, logger: ILogger, args: IFtpDeployArgumentsWithDefaults): void {
    logger.verbose(`Creating local state at ${args["local-dir"]}${args["state-name"]}`);
    fs.writeFileSync(`${args["local-dir"]}${args["state-name"]}`, JSON.stringify(localFiles, undefined, 4), { encoding: "utf8" });
    logger.verbose("Local state created");
}

async function connect(args: IFtpDeployArgumentsWithDefaults, logger: ILogger) {
    let protocol: string = "ftp";
    if (args.protocol === "ftps") {
        protocol = "ftps";
    }
    else if (args.protocol === "ftps-legacy") {
        protocol = "sftp";
    }

    //const rejectUnauthorized = args.security === "strict";

    try {
        var client = new FTPS({
            host: args.server,
            username: args.username,
            password: args.password,
            port: args.port,
            protocol: protocol
        });
        return client;
    }
    catch (error) {
        logger.all("Failed to connect, are you sure your server works via FTP or FTPS? Users sometimes get this error when the server only supports SFTP.");
        throw error;
    }


}

async function getServerFiles(client: FTPS, logger: ILogger, timings: ITimings, args: IFtpDeployArgumentsWithDefaults): Promise<IFileList> {
    try {
        await ensureDir(client, logger, timings, args["server-dir"]);

        if (args["dangerous-clean-slate"]) {
            logger.all(`----------------------------------------------------------------`);
            logger.all("🗑️ Removing all files on the server because 'dangerous-clean-slate' was set, this will make the deployment very slow...");
            await client.rmdir(client.ls().exec(console.log));
            logger.all("Clear complete");

            throw new Error("nope");
        }

        const serverFiles = await downloadFileList(client, logger, args["state-name"]);
        logger.all(`----------------------------------------------------------------`);
        logger.all(`Last published on 📅 ${new Date(serverFiles.generatedTime).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric" })}`);

        // apply exclude options to server
        if (args.exclude.length > 0) {
            const filteredData = serverFiles.data.filter((item) => applyExcludeFilter({ path: item.name, isDirectory: () => item.type === "folder" }, args.exclude));
            serverFiles.data = filteredData;
        }

        return serverFiles;
    }
    catch (error) {
        logger.all(`----------------------------------------------------------------`);
        logger.all(`No file exists on the server "${args["server-dir"] + args["state-name"]}" - this must be your first publish! 🎉`);
        logger.all(`The first publish will take a while... but once the initial sync is done only differences are published!`);
        logger.all(`If you get this message and its NOT your first publish, something is wrong.`);

        // set the server state to nothing, because we don't know what the server state is
        return {
            description: syncFileDescription,
            version: currentSyncFileVersion,
            generatedTime: new Date().getTime(),
            data: [],
        };
    }
}

export async function deploy(args: IFtpDeployArgumentsWithDefaults, logger: ILogger, timings: ITimings): Promise<void> {
    timings.start("total");

    // header
    logger.all(`----------------------------------------------------------------`);
    logger.all(`🚀 Thanks for using ftp-deploy. Let's deploy some stuff!   `);
    logger.all(`----------------------------------------------------------------`);
    logger.all(`If you found this project helpful, please support it`);
    logger.all(`by giving it a ⭐ on Github --> https://github.com/SamKirkland/FTP-Deploy-Action`);
    logger.all(`or add a badge 🏷️ to your projects readme --> https://github.com/SamKirkland/FTP-Deploy-Action#badge`);
    logger.verbose(`Using the following excludes filters: ${JSON.stringify(args.exclude)}`);

    timings.start("hash");
    const localFiles = await getLocalFiles(args);
    timings.stop("hash");

    createLocalState(localFiles, logger, args);

    let client = null;

    global.reconnect = async function () {
        timings.start("connecting");
        client = await connect(args, logger);
        timings.stop("connecting");
    }


    let totalBytesUploaded = 0;
    try {
        await global.reconnect();
        if (client == null) {
            return;
        }
        const serverFiles = await getServerFiles(client, logger, timings, args);

        timings.start("logging");
        const diffTool: IDiff = new HashDiff();

        logger.standard(`----------------------------------------------------------------`);
        logger.standard(`Local Files:\t${formatNumber(localFiles.data.length)}`);
        logger.standard(`Server Files:\t${formatNumber(serverFiles.data.length)}`);
        logger.standard(`----------------------------------------------------------------`);
        logger.standard(`Calculating differences between client & server`);
        logger.standard(`----------------------------------------------------------------`);

        const diffs = diffTool.getDiffs(localFiles, serverFiles);

        diffs.upload.filter((itemUpload) => itemUpload.type === "folder").map((itemUpload) => {
            logger.standard(`📁 Create: ${itemUpload.name}`);
        });

        diffs.upload.filter((itemUpload) => itemUpload.type === "file").map((itemUpload) => {
            logger.standard(`📄 Upload: ${itemUpload.name}`);
        });

        diffs.replace.map((itemReplace) => {
            logger.standard(`🔁 File replace: ${itemReplace.name}`);
        });

        diffs.delete.filter((itemUpload) => itemUpload.type === "file").map((itemDelete) => {
            logger.standard(`📄 Delete: ${itemDelete.name}    `);
        });

        diffs.delete.filter((itemUpload) => itemUpload.type === "folder").map((itemDelete) => {
            logger.standard(`📁 Delete: ${itemDelete.name}    `);
        });

        diffs.same.map((itemSame) => {
            if (itemSame.type === "file") {
                logger.standard(`⚖️  File content is the same, doing nothing: ${itemSame.name}`);
            }
        });
        timings.stop("logging");


        totalBytesUploaded = diffs.sizeUpload + diffs.sizeReplace;

        timings.start("upload");
        try {
            const syncProvider = new FTPSyncProvider(client, logger, timings, args["local-dir"], args["server-dir"], args["state-name"], args["dry-run"]);
            await syncProvider.syncLocalToServer(diffs);
        }
        finally {
            timings.stop("upload");
        }
    }
    catch (error) {
        prettyError(logger, args, error);
        throw error;
    }
    finally {
        timings.stop("total");
    }


    const uploadSpeed = prettyBytes(totalBytesUploaded / (timings.getTime("upload") / 1000));

    // footer
    logger.all(`----------------------------------------------------------------`);
    logger.all(`Time spent hashing: ${timings.getTimeFormatted("hash")}`);
    logger.all(`Time spent connecting to server: ${timings.getTimeFormatted("connecting")}`);
    logger.all(`Time spent deploying: ${timings.getTimeFormatted("upload")} (${uploadSpeed}/second)`);
    logger.all(`  - changing dirs: ${timings.getTimeFormatted("changingDir")}`);
    logger.all(`  - logging: ${timings.getTimeFormatted("logging")}`);
    logger.all(`----------------------------------------------------------------`);
    logger.all(`Total time: ${timings.getTimeFormatted("total")}`);
    logger.all(`----------------------------------------------------------------`);
}