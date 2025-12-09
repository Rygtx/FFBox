import Http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import CryptoJS from 'crypto-js';
import Koa from 'koa';
import Router from 'koa-router';
import { koaBody } from 'koa-body';
import koaStatic from 'koa-static';
import koaMount from 'koa-mount';
// import formidable from 'formidable';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FFBoxServiceEventApi, FFBoxServiceEventParam, FFBoxServiceFunctionApi } from '@common/types';
import { version } from '@common/constants';
import { getSingleArgvValue, randomString } from '@common/utils';
import { getOs, log } from './utils';
import localConfig from '@common/localConfig';
import { FFBoxService } from './FFBoxService';

interface Client {
	ws: WebSocket;
	sessionId: string;
	username: string | undefined;
	functionLevel: number;
}

let server: Http.Server | null;
let koa: Koa | null;
let wss: WebSocket.Server | null;
let clients = new Map<string, Client>();
let ffboxService: FFBoxService | null;

const uploadDir = os.tmpdir() + '/FFBoxUploadCache'; // 文件上传目录
const downloadDir = os.tmpdir() + '/FFBoxDownloadCache'; // 文件下载目录

const uiBridge = {
	init(self: FFBoxService): void {
		ffboxService = self;
		const uploadDirCheck = new Promise((resolve) => {
			fs.access(uploadDir, fs.constants.F_OK, (err) => {
				return resolve(err ? false : true);
			});
		});
		const downloadDirCheck = new Promise((resolve) => {
			fs.access(downloadDir, fs.constants.F_OK, (err) => {
				return resolve(err ? false : true);
			});
		});
		Promise.all([uploadDirCheck, downloadDirCheck]).then((values) => {
			if (!values.every((value) => value)) {
				log.info('创建缓存文件夹', uploadDir, downloadDir);
				fs.mkdir(uploadDir, () => {});
				fs.mkdir(downloadDir, () => {});
			}
		});
		// koaBody({
		// 	multipart: true,
		// 	formidable: {
		// 		maxFileSize: 1024 ** 4, // 设置上传文件大小最大限制为 1TiB，默认 2MB
		// 		uploadDir,
		// 	},
		// });
	},

	listen(): void {
		koa = new Koa();

		// 初始化响应头和响应码
		koa.use(async (ctx, next) => {
			log.dev('收到请求。', ctx.request.url);
			ctx.response.set('Access-Control-Allow-Origin', '*');
			ctx.response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
			ctx.response.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
			ctx.response.set('Access-Control-Max-Age', '999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999');
			if (ctx.request.method === 'OPTIONS') {
				ctx.response.status = 204;
				// ctx.response.message = '多 9 余';
				return;	// 直接返回，不走后续逻辑
			}
			if (ctx.path.startsWith('/download')) {
				const fileBaseName = ctx.query.fileBaseName as string || path.basename(ctx.path);
				ctx.response.set('Content-Disposition', `attachment; filename="${encodeURI(fileBaseName)}`);
			}
			try {
				await next();
			} catch (err) {
				console.log(err);
			}
		});

		// session 校验中间件
		koa.use(async (ctx, next) => {
			if (['/login', '/version'].includes(ctx.path) || ctx.path.includes('/download')) {
				// 登录和获取版本接口可不鉴权
				// 下载接口若需使用自定义 header 鉴权，必须使用 js 进行请求，不能用浏览器的下载管理器。工程上的做法是新建一个接口，由 sessionId 和下载地址生成一个带签名的直链，再进行下载。FFBox 暂不将此作为工作重心，所以不管了
				return next();
			}
			const authHeader = ctx.get('Authorization');
			if (authHeader && authHeader.startsWith('Bearer ')) {
				// const sessionId = ctx.get('Session-Id'); // 注意 ctx.get 获取 header 不区分大小写
				const sessionId = authHeader.slice(7); // 去掉 "Bearer "
				if (!sessionId || (clients.get(sessionId)?.functionLevel || 0) <= 0) {
					ctx.status = 401;
					return;
				}
				await next();	// 校验通过，进入后续路由
			}
		});

		// 读取请求体，提取到 request.body 中
		koa.use(
			koaBody({
				multipart: true,
				formidable: {
					maxFileSize: 1024 ** 4, // 设置上传文件大小最大限制为 1TiB，默认 2MB
					uploadDir,
				},
			}),
		);

		// 下载资源响应
		const staticServer = koaStatic(`${os.tmpdir()}/FFBoxDownloadCache`);
		koa.use(koaMount('/download', staticServer));

		// 路由
		const router = getRouter();
		koa.use(router.routes());

		server = Http.createServer(koa.callback());

		// wss = new (WebSocket.Server || WebSocketServer)({ server }); // https://github.com/websockets/ws/issues/1538
		wss = new WebSocket.Server({ server });

		const port = +(getSingleArgvValue('--port') || 33269);
		server.listen(port);
		log.info(`Websocket 开始监听端口 ${port}。`);

		// 挂载 WebSocket 服务器相关事件
		wss.on('connection', mountWebSocketEvents);
		wss.on('error', function (error: Error) {
			log.error('Websocket 服务出错，建议检查防火墙。', error);
			ffboxService!.emit('serverError', { error });
			wss = null;
		});
		wss.on('close', function () {
			ffboxService!.emit('serverClose');
			log.info('Websocket 服务关闭。');
			wss = null;
		});
		setTimeout(() => {
			if (wss) {
				mountEventFromService();
				ffboxService!.emit('serverReady');
			}
		}, 0);
	},
};

// #region 事件挂载区

/**
 * 每个传入的 WebSocket 客户端连接都听过此函数挂载事件监听
 * 4.4 及更新版本的客户端会首先检查客户端版本再进行 WebSocket 连接，然后等待 sessionId。因此客户端接入后需尽快返回 sessionId，提供给客户端进行 login
 * 为什么不是在 Websocket 连接后直接通过 Websocket 登录，而是要另发请求呢？这是因为登录是一种“请求”，尽量不做成“事件”让客户端转锁等待
 */
function mountWebSocketEvents(ws: WebSocket, request: Http.IncomingMessage): void {
	const address = request.socket.remoteAddress;
	const sessionId = randomString(6);
	const client: Client = { ws, sessionId, username: undefined, functionLevel: 0 };
	clients.set(sessionId, client);
	log.info(`新客户端接入：${address}。sessionId：${sessionId}。当前客户端数量：${clients.size}.`);

	ws.on('message', function (message: Buffer, isBinary: boolean): void {
		// console.log('uiBridge: 收到来自客户端的消息', message);
		if (!isBinary) {
			if (client.functionLevel <= 0) {
				log.dev(`客户端 ${sessionId} 未登录，调用已拒绝`, message.toString());
				return;
			}
			handleMessageFromClient(message.toString(), ws);
		}
	});
	ws.on('close', function (code: number, reason: string) {
		clients.delete(sessionId);
		log.info(`客户端连接关闭：${address}。当前客户端数量：${clients.size}。`, code, reason);
	});
	ws.on('error', function (err: Error) {
		log.error(`客户端连接出错：${address}。`, err);
	});
	ws.on('open', function () {
		log.info(`客户端连接打开：${address}。`);
	});

	const data: FFBoxServiceEventApi = {
		event: 'sessionId',
		payload: sessionId,
	};
	ws.send(JSON.stringify(data));
}

/**
 * 接受 UI 事件入口（来自 ws.onmessage）
 */
function handleMessageFromClient(message: string, wsClient: WebSocket): void {
	if (!ffboxService) {
		throw new Error('uiBridge 使用前应 init()');
	}
	const data: FFBoxServiceFunctionApi = JSON.parse(message);
	const args = data.args;
	log.dev('收到调用：', data);
	// @ts-ignore
	const result = ffboxService[data.function](...args.map((value) => (value === null ? undefined : value)));
	if (result instanceof Promise && typeof data.seq === 'number') {
		result.then((result) => {
			const response: FFBoxServiceEventApi = {
				event: 'ack',
				payload: {
					seq: data.seq,
					ok: true,
					result,
				},
			};
			wsClient.send(JSON.stringify(response));
		}).catch((reason) => {
			const response: FFBoxServiceEventApi = {
				event: 'ack',
				payload: {
					seq: data.seq,
					ok: false,
					result: reason,
				},
			};
			wsClient.send(JSON.stringify(response));
		});
	}
}

/**
 * 挂载 ffboxService 事件发送到 UI 的监听
 */
function mountEventFromService(): void {
	if (!ffboxService || !wss) {
		throw new Error('uiBridge 使用前应 init()');
	}
	// eslint-disable-next-line
	const eventsEnum: Array<keyof FFBoxServiceEventParam> = [
		'ffmpegInfo',
		"workingStatusUpdate",
		"tasklistUpdate",
		"taskUpdate",
		"cmdUpdate",
		"progressUpdate",
		"notificationUpdate",
	]
	for (const event of eventsEnum) {
		ffboxService.on(event, (payload: FFBoxServiceEventParam[keyof FFBoxServiceEventParam]) => {
			for (const client of wss!.clients) {
				if (client.readyState === client.OPEN) {
					const data: FFBoxServiceEventApi = {
						event,
						payload,
					};
					log.dev('触发信息：', data);
					// console.log('将要发送 ws 信息', event, event === 'taskUpdate' ? [(payload as any).content.after.input.files, (payload as any).content.paraArray.join(' ')] : undefined);
					client.send(JSON.stringify(data));
				}
			}
		});
	}
}

// #endregion

// #region http request 服务区

/**
 * 网络文件添加说明
 * 1. addTask，文件路径留空，指示该文件未 ready，暂不调用 FFmpeg 读取信息
 * 2. 前端扫描整个文件 md5，/upload/check 检查文件是否已缓存，已缓存返回奇数
 * 3. 前端判断文件完整性，然后 /upload/file 上传文件（后端根据文件名信息判断是否已缓存，过滤非法请求）
 * 5. updateUploadProgress，上传过程中更新任务的进度
 * 4. mergeUploaded 文件上传完成后，前端发送 md5 列表和任务 id，后端更新任务信息然后 TaskUpdate
 */

function getRouter(): Router {
	const router = new Router();

	// 获取 FFBoxService 版本
	router.get('/version', async function (ctx) {
		const result = version;
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	// 获取 FFBoxService 各种信息
	router.get('/properties', async function (ctx) {
		const result = {
			os: getOs(),
			isSandboxed: process.cwd() === '/', // macOS 中，直接双击运行服务（无论是否在 app 内）会得到用户目录，在终端运行会得到终端当前目录，通过 FFBox 调用会得到 '/'
			machineId: ffboxService.machineId,
			functionLevel: ffboxService.functionLevel,
			ffmpegInfo: ffboxService.ffmpegInfo,
		};
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	// 登录
	router.post('/login', async function (ctx) {
		if (!ctx.request.body) {
			// 非法请求
			ctx.response.status = 400;
			return;
		}
		const result = { isUserExist: false, isSuccess: false, functionLevel: 0 };
		const body = ctx.request.body;
		if (body.sessionId) {
			const users: { username: string; passkey: string; maxFunctionLevel: number }[]
				= (await localConfig.get('userInfo.users') as any) || [{ username : "", passkey: "", maxFunctionLevel: 100 }];
			const client = clients.get(body.sessionId);
			const user = users.find((user) => user.username === body.username);
			if (client && user) {
				result.isUserExist = true;
				if (!user.passkey || user.passkey === body.passkey) {
					result.isSuccess = true;
					result.functionLevel = user.maxFunctionLevel;
					client.functionLevel = user.maxFunctionLevel;
					client.username = body.username;
					ctx.response.status = 200;
					ctx.response.body = result;
					return;
				}
			}
		}
		ctx.response.status = 400;
		ctx.response.body = result;
	});

	// 获取服务器通知
	router.get('/notification', async function (ctx) {
		const result = ffboxService.notifications;
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	// 获取已扫描的 FFmpeg 编码器、（解）复用器、滤镜信息
	router.get('/AVOptions', async function (ctx) {
		const result = {
			codecs: ffboxService.ffmpegCodecs,
			formats: ffboxService.ffmpegFormats,
			filters: ffboxService.ffmpegFilters,
		};
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	// 获取服务器运行状态
	router.get('/workingStatus', async function (ctx) {
		const result = ffboxService.workingStatus;
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	// 检查文件是否已缓存
	// 已缓存返回奇数
	router.post('/upload/check/', async function (ctx) {
		if (!ctx.request.body || !(ctx.request.body.hashs instanceof Array)) {
			// 非法请求
			ctx.response.status = 400;
			return;
		}
		// 暂定 body 里的属性只有一个 hashs: Array<string>，不写 ts 定义了
		log.info('检查文件缓存性', ctx.request.body.hashs);
		const hashs = ctx.request.body.hashs as Array<string>;
		const ret: Array<number> = [];
		for (const hash of hashs) {
			const filePath = uploadDir + '/' + hash;
			if (fs.existsSync(filePath)) {
				ret.push(1);
			} else {
				ret.push(0);
			}
		}
		ctx.response.status = 200;
		ctx.response.body = ret;
	});

	// 接收文件
	router.post('/upload/file', async function (ctx) {
		if (!ctx.request.files || !ctx.request.files.file /* || !(ctx.request.files instanceof formidable.File)*/) {
			// 非法请求
			ctx.response.status = 400;
			return;
		}
		const file = ctx.request.files.file /*as formidable.File*/ as any;
		const body = ctx.request.body;
		log.info('收到文件', file.originalFilename);
		const destPath = uploadDir + '/' + body.name;
		try {
			fs.renameSync(file.filepath, destPath);
			log.info('文件已缓存至', destPath);
			ctx.response.status = 200;
		} catch (error) {
			log.error('文件重命名失败', error);
			ctx.response.status = 500;
		}
	});

	// 因 ws RPC 暂时没做中间件设计，而 taskAdd 需要由后端处理传入 isRemote，所以这里使用请求
	router.put('/task', async function (ctx) {
		if (!ctx.request.body) {
			// 非法请求
			ctx.response.status = 400;
			return;
		}
		const body = ctx.request.body;
		const result = await ffboxService!.taskAdd(body.taskName, body.outputParams, ctx.URL.hostname !== 'localhost');
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	// 获取任务 ID 列表
	router.get('/task', async function (ctx) {
		const result = Object.keys(ffboxService.tasklist).map(Number);
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	// 获取单个任务信息
	router.get('/task/:id', async function (ctx) {
		const result = ffboxService.tasklist[+ctx.params.id];
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	// 激活
	router.post('/activation', async function (ctx) {
		if (!ctx.request.body?.userInput) {
			// 非法请求
			ctx.response.status = 400;
			return;
		}
		const userInput = ctx.request.body.userInput;
		const fixedCode = 'd324c697ebfc42b7';
		const key = ffboxService.machineId + fixedCode;
		const decrypted = CryptoJS.AES.decrypt(userInput, key);
		const activationResult = CryptoJS.enc.Utf8.stringify(decrypted);
		if (parseInt(activationResult).toString() === activationResult) {
			ffboxService.functionLevel = parseInt(activationResult);
			localConfig.set('userInfo.activationCode', userInput);
			const returnEncrypted = CryptoJS.AES.encrypt(activationResult, fixedCode).toString();
			ctx.response.status = 200;
			ctx.response.body = returnEncrypted;
		} else {
			ctx.response.status = 200;
		}
	});

	// 获取缓存
	router.get('/cache', async function (ctx) {
		const result = await ffboxService!.getCacheInfo(false);
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	// 清除缓存
	router.delete('/cache', async function (ctx) {
		const result = await ffboxService!.getCacheInfo(true);
		ctx.response.status = 200;
		ctx.response.body = result;
	});

	return router;
}

// #endregion

export default uiBridge;
