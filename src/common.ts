
import * as request from "request";
import {Readable, Writable} from "stream";
import {exec, spawn} from "child_process";
import {RequestResponse} from "request";
import * as http from "http";
import * as https from "https";
import * as UrlParser from "url";
import {homedir} from "os";
import {ensureDir, writeFile} from "fs-extra";
import {createReadStream, createWriteStream, existsSync, readFileSync} from "fs";
import {createServer} from "http";
import * as QueryStringParser from "querystring";
import * as os from "os";
import * as open from "open";
import * as tar from 'tar';
import {BaseOptions, InitOptions} from "./types";
const BablicApiBase = "https://www.bablic.com/api/v2/";
const BablicApiBaseParsed = UrlParser.parse(BablicApiBase);

let token: string;

const parentDir = homedir();
const bablicConf = parentDir + "/.bab";

if (existsSync(bablicConf)) {
    token = readFileSync(bablicConf, {encoding: "utf8"});
}

export function jsonPost<TReq, TRes>(url: string, body: TReq, options?: any): Promise<TRes> {
    return new Promise<TRes>((resolve, reject) => {
        request.post({
            url: BablicApiBase + url,
            json: body,
            headers: token ? {"cookie": "babsession=" + token + ";"} : null,
        }, (err, response) => {
            if (err) {
                return reject(err);
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
                return reject({code: response.statusCode, body: response.body});
            }
            resolve(response.body as TRes);
        }).on("error", (e) => reject(e));
    });
}

export async function postStream(url: string, stream: Readable): Promise<Readable> {
    return new Promise<Readable>((resolve, reject) => {
        const protocol = BablicApiBaseParsed.protocol === 'https:' ? https : http;
        const req = protocol.request({
            method: "POST",
            host: BablicApiBaseParsed.host,
            path: BablicApiBaseParsed.pathname + url,
            headers: Object.assign({
              'content-type': 'text/xml',
            }, token ? {
                "cookie": "babsession=" + token + ";",
            } : {}),
        });
        req.on("error", (e) => reject(e));
        req.on("response", (response) => {
            response.pause();
            if (response.statusCode < 200 || response.statusCode >= 300) {
                return reject({ code: response.statusCode});
            }
            resolve(response);
        }).on("error", (e) => reject(e));
        stream.pipe(req);
    });
}
export function execShellCommand(cmd: string, args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = exec(cmd + " " + args.map((a) => JSON.stringify(a)).join(" "), (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
        child.stdout.on('data', (data) => {
            process.stdout.write(data);
        });

        child.stderr.on('data', (data) => {
            process.stderr.write(data);
        });
    });
}

export function waitForSigterm(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        process.on("SIGTERM", () => resolve());
    });
}

export async function saveToken(token: string): Promise<void> {
    await writeFile(bablicConf, token, {encoding: "utf8"});
}

export interface LoginOptions extends BaseOptions {
    //
}

export function waitForLogin(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const server = createServer((req, res) => {
            const qs = req.url.split("?")[1];
            if (!qs) {
                return res.end();
            }
            const parsed = QueryStringParser.parse(qs);
            const token = parsed.token;
            const redirect = parsed.redirect;
            if (!token) {
                return res.end();
            }
            if (redirect) {
                res.writeHead(301, {location: redirect});
                res.end();
            } else {
                res.writeHead(301, {location: "https://www.bablic.com/?title=Login+successfull&message=You+can+close+this+window+and+go+back+to+your+sdk"});
                res.end();
            }
            saveToken(token as string).then(() => {
                server.close();
                resolve();
            }, reject);
        });
        server.listen(12513);
    });

}

export async function login(params: LoginOptions): Promise<void> {
    const promise = waitForLogin();
    await open("https://www.bablic.com/?step=login&next=" + encodeURIComponent("http://localhost:12513?token=[token]"));
    await Promise.race([promise, waitForSigterm()]);
}

export async function createSite(channel: string, params: InitOptions): Promise<void> {
    const siteId = await jsonPost(channel + "/create", params);
    console.error("Site created with id", siteId);
}

export async function createTranslationFile(reader: Readable, writer: Writable, site: string, locale: string, channel: string): Promise<void> {
    const stream = await postStream(`site/${encodeURIComponent(site)}/i18n/${channel}/locale/${locale}`, reader);
    stream.pipe(writer);
    const promise = new Promise<void>((resolve, reject) => {
        writer.on("close", () => {
            resolve();
        });
    });
    await promise;
}
export async function createEditorFile(reader: Readable, writer: Writable, site: string, format: string): Promise<void> {
    return createTranslationFile(reader, writer, site, "editor", format);
}

export async function uploadSiteAndOpenEditor(tempDir: string, site: string, channel: string) {
    const tempTar = os.tmpdir() + `/${site}.editor.tar.gs`;
    const tempTarWriter = createWriteStream(tempTar);
    tar.c({
        gzip: true,
    }, [tempDir]).pipe(tempTarWriter);
    await new Promise<void>((resolve, reject) => {
        tempTarWriter.on("close", () => resolve());
    });

    const tarReader = createReadStream(tempTar);
    const bundleResponse = await postStream(`site/${site}/i18n/${channel}/bundle`, tarReader);
    let url: string;
    const readPromise = new Promise<void>((resolve, reject) => {
        const chunks: string[] = [];
        bundleResponse.on("readable", () => {
            chunks.push(bundleResponse.read().toString());
        });
        bundleResponse.on("end", () => {
            const str = chunks.join("");
            const obj = JSON.parse(str);
            url = obj.url;
            console.error("Open browser in URL:", obj.url);
            resolve();
        });
    });
    await readPromise;
    const logInPromise = waitForLogin();
    await open(url);
    await Promise.race([logInPromise, waitForSigterm()]);
}