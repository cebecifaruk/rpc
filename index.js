const http = require("http");
const WebSocket = require("ws");
const assert = require("assert");
const crypto = require("crypto");
const uuid = require("uuid");
const net = require("net");

// TODO: Fallback for HTTP
// TODO: One shot sessions

const generateId = uuid.v4;


const getHttpBody = (req) =>
    new Promise((res, rej) => {
        let body = [];
        req
            .on("data", (chunk) => {
                body.push(chunk);
            })
            .on("end", () => {
                res(Buffer.concat(body).toString());
            });
    });

const isRpc = x => {
    const keys = Object.keys(x);
    return keys.length === 3 &&
        keys.includes("id") &&
        keys.includes("method") &&
        keys.includes("params")
}

const isResponse = x => {
    const keys = Object.keys(x);
    return keys.length === 3 &&
        keys.includes("id") &&
        keys.includes("result") &&
        keys.includes("error")
}

const Safe = (f, err) => {
}


function HttpResponse(status, headers, body) {
    const httpResponse = { status, headers, body };
    httpResponse.__proto__ = HttpResponse.prototype;
    return httpResponse;
}


function createApi() {
    async function api($, method, ...params) {
        assert(method in api.methods && typeof api.methods[method] === "function", "Unknown method");
        const result = api.methods[method]($, ...params);
        if (result instanceof Promise) return await result;
        return result;
    }

    api.methods = {};
    api.sessions = {};

    api.createSession = async (context, send, close) => {
        async function session(method, ...params) {
            return await api(session.context, method, ...params);
        };

        session.jsonRpc = async (id, method, ...params) => {
            const result = await session(method, ...params);
            try {
                return {
                    id,
                    result: result === undefined ? null : result,
                    error: null,
                };
            } catch (e) {
                return {
                    id,
                    result: null,
                    error: e instanceof assert.AssertionError ? e.message : String(e),
                };
            }
        }

        session.close = async () => {
            if ("onDestroy" in api.methods) await session("onDestroy");
            delete api.sessions[session.id];
            if (typeof close === "function") close();
            return;
        };

        session.id = generateId();
        session.send = send;

        session.context = { ...context, api };
        session.getVar = (name) => session.context[name];
        session.setVar = (name, value) => session.context[name] = value;


        session.callIds = {};
        session.call = (method, ...params) => {
            const id = generateId();
            session.send(JSON.stringify({ id, method, params }));
            return new Promise((res, rej) => {
                session.callIds[id] = [res, rej];
            });
        }
        session.handle = (id, result, error) => {
            console.log(session.callIds);
            if (!(id in session.callIds)) return;
            const [res, rej] = session.callIds[id];
            if (error === null || error === undefined) res(result);
            else rej(error);
            delete session.callIds[id];
        }

        if ("onCreate" in api.methods) await api(session.context, "onCreate");
        api.sessions[session.id] = session;

        return session;
    }

    api.function = (name, f) => api.methods[name] = f;
    api.method = (name, m) => api.methods[name] = ($, method, ...params) => m.bind($)(method, ...params);

    api.functions = (fns) => Object.entries(fns).forEach(([name, f]) => api.fn(name, f));
    api.methods = (mts) => Object.entries(mts).forEach(([name, m]) => api.mt(name, m));

    api.fn = api.function;
    api.mt = api.method;

    api.httpHandler = async (req, res) => {
        // Body Getter and Parser

        const headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "*",
            "Content-Type": "application/json",
        };

        const sendJSON = (x) => {
            try {
                return res
                    .writeHead(200, headers)
                    .end(String(JSON.stringify(x)));
            } catch (e) {
                return res
                    .writeHead(502, headers).end(JSON.stringify({ error: "Response is not a JSON" }));
            }
        };


        if (req.method == "OPTIONS") return res.writeHead(200, headers).end();
        if (req.method !== "POST") {
            if (!("http" in api.methods)) return sendJSON({ id: null, error: "Default Http Handler function not found!", result: null });
            try {
                const result = await api({
                    headers: req.headers,
                    method: req.method,
                    url: req.url,
                    httpVersion: req.httpVersion,
                    HttpResponse
                }, "http", req.body);
                if (!(result instanceof HttpResponse)) throw "Invalid Http Response from the function!";
                return res.writeHead(result.status, result.headers).end(result.body);
            } catch (e) {
                return sendJSON({ id: null, error: String(e), result: null });
            }
        }

        var id = null;

        try {
            const body = req.url.startsWith("/rpc/") ? {
                id: 0,
                method: req.url.slice(5),
                params: [JSON.parse(await getHttpBody(req))]
            } : JSON.parse(await getHttpBody(req));

            id = "id" in body ? body.id : undefined;

            assert(isRpc(body), "Not a valid JSON-RPC");


            const s = await api.createSession({
                token: req.headers["authorization"]
                    ? req.headers["authorization"].slice(7)
                    : null,
                method: req.method,
                url: req.url,
                httpVersion: req.httpVersion,
                ...req.headers,
                body,
            });


            const response = await s.jsonRpc(body.id, body.method, ...(Array.isArray(body.params) ? body.params : [body.params]));

            await s.close();

            if ("result" in response && response.result instanceof HttpResponse)
                return res
                    .writeHead(response.result.status, { ...headers, ...response.result.headers })
                    .end(response.result.body);


            return res
                .writeHead(("error" in response && response.error === null) ? 200 : 502, headers)
                .end(JSON.stringify(response));
        } catch (e) {
            return res
                .writeHead(502, headers)
                .end(JSON.stringify({ id, result: null, error: String(e) }));
        }

    };


    api.wsHandler = async (ws, req) => {
        const s = await api.createSession(
            {
                headers: req.headers,
                token: req.headers["authorization"],
            },
            (x) => ws.send(x),
            () => ws.terminate());

        ws.on("close", s.close);

        ws.on("message", async (msg) => {
            try {
                const parsed = JSON.parse(String(msg));

                if (isResponse(parsed)) {
                    s.handle(parsed.id, parsed.result, parsed.error);
                } else if (isRpc(parsed)) {
                    ws.send(JSON.stringify(await s.jsonRpc(
                        parsed.id,
                        parsed.method,
                        ...parsed.params
                    )) + "\r\n");
                } else
                    throw "Not a json rpc request";

            } catch (e) {
                ws.send(
                    JSON.stringify({
                        id: null,
                        result: null,
                        error: String(e),
                    }) + "\r\n");
            }
        })

        // Auto close connection
        var isAlive = true;
        var interval = null;
        interval = setInterval(() => {
            if (isAlive === false) {
                clearInterval(interval);
                return ws.terminate();
            }
            isAlive = false;
            ws.ping();
        }, 30000);
        ws.on("pong", function () {
            isAlive = true;
        });
    }

    api.listen = (port, ip = '0.0.0.0', websocket = true) => {
        const httpServer = http.createServer(api.httpHandler);
        httpServer.listen(port, ip);
        if (websocket) new WebSocket.Server({ server: httpServer, autoAcceptConnections: true })
            .on("connection", api.wsHandler);
    }

    api.connect = async (url, token) => {
        var ws = null;

        function call(method, ...params) {
            if (!ws instanceof WebSocket) throw "Not Connected to the server.";
            if (method != "loginWithSession" && !ws.apiReady) throw "Not ready";
            const id = generateId();
            const req = { id, method, params };
            ws.send(JSON.stringify(req) + "\r\n");
            return new Promise((res, rej) => {
                ws.handlers[id] = [res, rej];
            });
        }

        const connect = () => new Promise((res, rej) => {
            if (ws instanceof WebSocket && "handlers" in ws)
                Object.values(ws.handlers).forEach(([res, rej]) => rej(null));

            ws = new WebSocket(url);
            ws.apiReady = true;
            ws.handlers = {};
            ready = false;

            ws.on("open", () => {
                call("loginWithSession", token)
                    .then((result) => {
                        ws.apiReady = true;
                        res(null);
                        console.log(result);
                    })
                    .catch((e) => {
                        console.log(e)
                    });
            });

            ws.on("close", () => connect());
            ws.on("error", () => connect());

            ws.on("message", async (msg) => {
                try {
                    const parsed = JSON.parse(String(msg));
                    if (isResponse(parsed)) {
                        const [res, rej] = ws.handlers[parsed.id];
                        if (parsed.error === null) res(parsed.result);
                        else rej(parsed.error);
                    } else if (isRpc(parsed)) {
                        try {
                            const result = await api({}, parsed.method, ...parsed.params);
                            ws.send(JSON.stringify({ id: parsed.id, result: result === undefined ? null : result, error: null }) + "\r\n");
                        } catch (e) {
                            ws.send(JSON.stringify({ id: parsed.id, result: null, error: String(e) }) + "\r\n");
                        }
                    }
                } catch (e) {
                    console.log(e);
                }
            });
        });

        await connect();

        return call;
    }

    return api;
}

module.exports = createApi;