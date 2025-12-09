import EventEmitter from 'events';
import CryptoJS from 'crypto-js';
import { getTimeString, TypedEventEmitter } from '@common/utils';
import { FFBoxServiceEvent, FFBoxServiceEventApi, FFBoxServiceFunctionApi, FFBoxServiceInterface, Notification, OutputParams, Task } from '@common/types';

export interface ServeiceBridgeEvent {
	connected: () => void;
	disconnected: () => void;
	error: (reason: string) => void;
	message: (event: MessageEvent<any>) => void;
};

export enum ServiceBridgeStatus {
	Idle = 'Idle',
	Connecting = 'Connecting',
	Connected = 'Connected',
	Disconnected = 'Disconnected',
	Reconnecting = 'Reconnecting',
};

export class ServiceBridge extends (EventEmitter as new () => TypedEventEmitter<FFBoxServiceEvent & ServeiceBridgeEvent>) implements FFBoxServiceInterface {
	private ws: WebSocket | null = null;
	private seq = 0;
	private waitingForResponse: Map<number, [((okResult: any) => any)?, ((errResult: any) => any)?]> = new Map();
	public ip: string;
	public port: number;
	public username: string;
	public password: string;
	public status = ServiceBridgeStatus.Idle;
	public sessionId?: string;
	public functionLevel: number = NaN;

	constructor(ip?: string, port?: number) {
		super();
		setTimeout(() => {
			if (ip && port) {
				this.connect(ip, port);
			}
		}, 0);
	}

	public async connect(ip?: string, port?: number, username?: string, password?: string) {
		if (ip && port) {
			this.ip = ip;
			this.port = port;
		}
		if (this.status === ServiceBridgeStatus.Idle) {
			this.status = ServiceBridgeStatus.Connecting;
		} else if (this.status === ServiceBridgeStatus.Disconnected) {
			this.status = ServiceBridgeStatus.Reconnecting;
		} else {
			return;
		}

		const finalResult = await new Promise(async (connectResult, _) => {
			// 4.4 版本后的服务器具有登录系统。不支持以前版本的服务器
			const requestOK1 = await new Promise<boolean>((resolve, reject) => {
				console.log(`serviceBridge: 正在检查服务器版本 http://${this.ip}:${this.port}/`);
				fetch(`http://${ip}:${port}/version`, { method: 'get' }).then((res) => {
					res.text().then((text) => {
						resolve(true);
					}).catch(() => {
						resolve(false);
					});
				}).catch((err) => {
					resolve(false);
				});
			});
			if (!requestOK1) {
				this.emit('error', '连接失败：获取服务器版本失败');
				connectResult(false);
				return;
			}
	
			console.log(`serviceBridge: 正在连接服务器 ws://${this.ip}:${this.port}/`);
			let ws = new WebSocket(`ws://${this.ip}:${this.port}/`);
			this.ws = ws;
			let 这 = this;
			ws.onopen = async function (event) {
				console.log(`serviceBridge: ws://${这.ip}:${这.port}/ 服务器连接成功`, event);
				// 转锁 2s 等待 sessionId 返回（ws 不支持 once 监听 message，所以这里简便设计）
				for (let n = 50; n > 0; n--) {
					if (这.sessionId) {
						break;
					} else {
						await new Promise((r) => setTimeout(() => r(undefined), 40));
					}
				}
				if (!这.sessionId) {
					这.emit('error', '连接失败：服务器未及时返回 sessionId');
					ws.close();
					connectResult(false);
					return;
				}
				const [requestOK2, isUserExist, loginSuccess, functionLevel] = await new Promise<[boolean, boolean, boolean, number]>((resolve, reject) => {
					fetch(`http://${ip}:${port}/login`, {
						method: 'post',
						body: JSON.stringify({ username, passkey: CryptoJS.SHA256(password).toString(), sessionId: 这.sessionId }),
						headers: new Headers({
							'Content-Type': 'application/json'
						}),
					}).then((response) => {
						response.text().then((text) => {
							try {
								let result = JSON.parse(text);
								resolve([true, result.isUserExist, result.isSuccess, result.functionLevel]);
							} catch (e) {
								resolve([false, false, false, NaN]);
							}
						}).catch((err) => {
							resolve([false, false, false, NaN]);
						});
					}).catch((err) => {
						resolve([false, false, false, NaN]);
					});	
				});
				if (!requestOK2) {
					这.emit('error', '连接失败：登录连接失败');
					ws.close();
					connectResult(false);
					return;
				}		
				if (!isUserExist) {
					这.emit('error', '登录失败：用户名错误');
					ws.close();
					connectResult(false);
					return;
				}		
				if (!loginSuccess) {
					这.emit('error', '登录失败：密码错误');
					ws.close();
					connectResult(false);
					return;
				}
	
				这.status = ServiceBridgeStatus.Connected;
				这.emit('connected');
				connectResult(true);

				setTimeout(() => {
					// 这.testSendBigPackage();	// test
				}, 4000);
			}
			ws.onclose = function (event) {
				// close 事件在 error 事件后触发
				if (这.status === ServiceBridgeStatus.Connected) {
					// 掉线
					这.status = ServiceBridgeStatus.Disconnected;
				} else {
					// 未连接成功，由 onerror 处理过，这里不需处理
				}
				这.sessionId = undefined;
				这.functionLevel = NaN;
				这.emit('disconnected');
			}
			ws.onerror = function (event) {
				// console.log(`serviceBridge: ws://${这.ip}:${这.port}/ 服务器连接失败`, event);
				这.emit('error', 'Websocket 连接失败');
				return;
			}
			ws.onmessage = function (event) {
				// console.log(`serviceBridge: ws://${这.ip}:${这.port}/ 服务器发来消息`, event);
				// 这.emit('message', event);
				这.handleWsEvents(event);
			}
		});
		if (!finalResult) {
			if (this.status === ServiceBridgeStatus.Connecting) {
				// 第一次连接就失败
				this.status = ServiceBridgeStatus.Idle;
			} else if (this.status === ServiceBridgeStatus.Reconnecting) {
				// 连接后重连失败
				this.status = ServiceBridgeStatus.Disconnected;
			}
		}
	}

	public disconnect() {
		console.log(`serviceBridge: 正在断开服务器 ws://${this.ip}:${this.port}/`);
		this.ws?.close();
		this.ws = null;
		this.status = ServiceBridgeStatus.Idle;
	}

	/**
	 * 接受 service 事件入口（来自 ws.onmessage）
	 */
	private handleWsEvents(event: MessageEvent<any>) {
		let data: FFBoxServiceEventApi = JSON.parse(event.data);
		if (data.event === 'sessionId') {
			// 连接后，服务器将马上触发 sessionId 事件，此时即可使登录操作继续
			console.log(`本次登录 sessionId：${data.payload}`);
			this.sessionId = data.payload;
		} else if (data.event === 'ack') {
			const funcs = this.waitingForResponse.get(data.payload.seq);
			if (funcs) {
				if (data.payload.ok) {
					(funcs[0] || (() => {}))(data.payload.result);
				} else {
					(funcs[1] || (() => {}))(data.payload.result);
				}
				this.waitingForResponse.delete(data.payload.seq);
			}
		} else {
			this.emit(data.event, data.payload as any);
		}
	}

	private sendWs(data: FFBoxServiceFunctionApi) {
		this.status === ServiceBridgeStatus.Connected && this.ws?.send(JSON.stringify(data));
	}

	private testSendBigPackage() {
		console.log(getTimeString(new Date()), '发送大包');
		const array = new Float32Array(512);

		for (var i = 0; i < array.length; ++i) {
			array[i] = i;
		}
	  
		this.ws?.send(array);

	}

	// #region service 调用相关

	public initSettings() {
		let data: FFBoxServiceFunctionApi = {
			function: 'initSettings',
			args: [],
		}
		this.sendWs(data);
	}

	public initFFmpeg() {
		let data: FFBoxServiceFunctionApi = {
			function: 'initFFmpeg',
			args: [],
		}
		this.sendWs(data);
	}

	// public taskAdd(taskName: string, outputParams?: OutputParams): Promise<number> {
	// 	let data: FFBoxServiceFunctionApi = {
	// 		function: 'taskAdd',
	// 		args: [taskName, outputParams],
	// 		seq: ++this.seq,
	// 	}
	// 	this.sendWs(data);
	// 	return new Promise<number>((resolve, reject) => {
	// 		this.waitingForResponse.set(this.seq, [(result) => resolve(result), () => reject()]);
	// 	});
	// }
	// 因为 service 需要一个独特的 isRemote，所以这里不能用 ws RPC，需要用请求
	public taskAdd(taskName: string, outputParams?: OutputParams): Promise<number> {
		return new Promise((resolve, reject) => {
			fetch(`http://${this.ip}:${this.port}/task`, {
				method: 'put',
				body: JSON.stringify({ taskName, outputParams }),
				headers: new Headers({
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.sessionId}`,
				}),
			}).then((response) => {
				response.text().then((text) => {
					let id = parseInt(text);
					resolve(id);
				})
			}).catch((err) => reject(err))
		});
	}

	public mergeUploaded(id: number, hashs: string[], fileBaseName: string, inputName?: string, fileTime?: { accessTime: number, createTime: number, modifyTime: number }) {
		let data: FFBoxServiceFunctionApi = {
			function: 'mergeUploaded',
			args: [id, hashs, fileBaseName, inputName, fileTime],
		}
		this.sendWs(data);
	}

	public setUploadStatus(id: number, isUploading: boolean) {
		let data: FFBoxServiceFunctionApi = {
			function: 'setUploadStatus',
			args: [id, isUploading],
		}
		this.sendWs(data);
	}

	public activate(activationCode: string) {
		return new Promise<string | false>((resolve, reject) => {
			fetch(`http://${this.ip}:${this.port}/activation`, {
				method: 'post',
				headers: new Headers({
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.sessionId}`,
				}),
				body: JSON.stringify({ userInput: activationCode }),
			}).then((response) => {
				response.text().then((result) => {
					if (result) {
						const fixedCode = 'd324c697ebfc42b7';
						const decrypted = CryptoJS.AES.decrypt(result, fixedCode);
						const activationResult = CryptoJS.enc.Utf8.stringify(decrypted);
						resolve(activationResult);
					} else {
						console.error('后端解密失败');
						resolve(false);
					}
				}).catch((err) => {
					console.error('前端解密失败');
					resolve(false);
				});
			}).catch((err) => {
				resolve(false);
			});
		});
	}

	public getCacheInfo(needDelete: boolean): Promise<{ uploadCount: number, uploadSize: number, downloadCount: number, downloadSize: number }> {
		return new Promise((resolve, reject) => {
			fetch(`http://${this.ip}:${this.port}/cache`, {
				method: needDelete ? 'delete' : 'get',
				headers: new Headers({
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.sessionId}`,
				}),
			}).then((response) => {
				response.json().then((result) => resolve(result));
			}).catch((err) => {
				reject(err);
			});
		});
	}

	public taskDelete(id: number) {
		let data: FFBoxServiceFunctionApi = {
			function: 'taskDelete',
			args: [id],
		}
		this.sendWs(data);
	}

	public taskStart(id: number) {
		let data: FFBoxServiceFunctionApi = {
			function: 'taskStart',
			args: [id],
		}
		this.sendWs(data);
	}

	public taskReady(id: number) {
		let data: FFBoxServiceFunctionApi = {
			function: 'taskReady',
			args: [id],
		}
		this.sendWs(data);
	}

	public taskPause(id: number) {
		let data: FFBoxServiceFunctionApi = {
			function: 'taskPause',
			args: [id],
		}
		this.sendWs(data);
	}

	public taskResume(id: number) {
		let data: FFBoxServiceFunctionApi = {
			function: 'taskResume',
			args: [id],
		}
		this.sendWs(data);
	}

	public taskReset(id: number) {
		let data: FFBoxServiceFunctionApi = {
			function: 'taskReset',
			args: [id],
			seq: ++this.seq,
		}
		this.sendWs(data);
		return new Promise<void>((resolve, reject) => {
			this.waitingForResponse.set(this.seq, [() => resolve(), () => reject()]);
		});
	}

	public queueStart() {
		let data: FFBoxServiceFunctionApi = {
			function: 'queueStart',
			args: [],
		}
		this.sendWs(data);
	}

	public queuePause() {
		let data: FFBoxServiceFunctionApi = {
			function: 'queuePause',
			args: [],
		}
		this.sendWs(data);
	}

	public deleteNotification(notificationId: number) {
		let data: FFBoxServiceFunctionApi = {
			function: 'deleteNotification',
			args: [notificationId],
		}
		this.sendWs(data);
	}

	public setParameters(ids: number[], params: OutputParams[]) {
		let data: FFBoxServiceFunctionApi = {
			function: 'setParameters',
			args: [ids, params],
		}
		this.sendWs(data);
	}

	public trailLimit_stopTranscoding(id: number, reason: 'media' | 'working') {
		let data: FFBoxServiceFunctionApi = {
			function: 'trailLimit_stopTranscoding',
			args: [id, reason, true],
		}
		this.sendWs(data);
	}

	// #endregion

	// #region 直接获取信息

	public getProperties(): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			fetch(`http://${this.ip}:${this.port}/properties`, {
				method: 'get',
				headers: new Headers({
					// 'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.sessionId}`,
				}),
			}).then((response) => {
				response.json().then((result) => resolve(result));
			}).catch((err) => reject(err));
		});
	}

	public getWorkingStatus(): Promise<string> {
		return new Promise<any>((resolve, reject) => {
			fetch(`http://${this.ip}:${this.port}/workingStatus`, {
				method: 'get',
				headers: new Headers({
					// 'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.sessionId}`,
				}),
			}).then((response) => {
				response.text().then((content) => resolve(content));
			}).catch((err) => reject(err));
		});
	}

	public getTaskList(): Promise<number[]> {
		return new Promise<number[]>((resolve, reject) => {
			fetch(`http://${this.ip}:${this.port}/task`, {
				method: 'get',
				headers: new Headers({
					// 'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.sessionId}`,
				}),
			}).then((response) => {
				response.json().then((result) => resolve(result));
			}).catch((err) => reject(err));
		});
	}

	public getTask(taskId: number): Promise<Task> {
		return new Promise((resolve, reject) => {
			fetch(`http://${this.ip}:${this.port}/task/${taskId}`, {
				method: 'get',
				headers: new Headers({
					// 'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.sessionId}`,
				}),
			}).then((response) => {
				response.json().then((result) => resolve(result));
			}).catch((err) => reject(err));
		});
	}

	public getNotifications(): Promise<Notification[]> {
		return new Promise((resolve, reject) => {
			fetch(`http://${this.ip}:${this.port}/notification`, {
				method: 'get',
				headers: new Headers({
					// 'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.sessionId}`,
				}),
			}).then((response) => {
				response.json().then((result) => resolve(result));
			}).catch((err) => reject(err));
		});
	}

	public getAVOptions(): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			fetch(`http://${this.ip}:${this.port}/AVOptions`, {
				method: 'get',
				headers: new Headers({
					// 'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.sessionId}`,
				}),
			}).then((response) => {
				response.json().then((result) => resolve(result));
			}).catch((err) => reject(err));
		});
	}

	// #endregion
}
