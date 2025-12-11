import { h, VNodeRef } from 'vue';
import { defineStore } from 'pinia';
import CryptoJS from 'crypto-js';
import { FFmpegCodecDetail, FFmpegDemuxerDetail, FFmpegFilterDetail, FFmpegMuxerDetail, Notification, NotificationLevel, OutputParams, WorkingStatus } from '@common/types';
import { version } from '@common/constants'; 
import { Server } from '@renderer/types';
import { defaultParams } from "@common/defaultParams";
import { ServiceBridge, ServiceBridgeStatus } from '@renderer/bridges/serviceBridge'
import { randomString, replaceOutputParams } from '@common/utils';
import { getMenuItemByValue } from '@common/menu';
import { allVcodecs, builtInVcodecs } from '@common/params/vcodecs';
import { allAcodecs, builtInAcodecs } from '@common/params/acodecs';
import { allMuxers, builtInMuxers } from '@common/params/formats';
import path from '@common/path';
import { parseFFmpegCodecsToCodecsList, parseFFmpegFiltersToFiltersList, parseFFmpegMuDeMuxersToList } from '@common/params/parser';
import { handleCmdUpdate, handleFFmpegInfo, handleProgressUpdate, handleTasklistUpdate, handleNotificationUpdate, handleTaskUpdate, handleWorkingStatusUpdate } from '@renderer/logic/eventsHandler';
import nodeBridge from '@renderer/bridges/nodeBridge';
import { addUploadTask } from '../logic/transferManager2';
import { getLimitaion } from '../logic/limitaions';
import Popup from '@renderer/components/Popup/Popup';

const { trimExt } = path;

interface StoreState {
	// 界面类
	showMenuCenter: 0 | 1 | 2; // 0：关闭　1：开启菜单栏　2：全开
	showInfoCenter: boolean;
	showTransferCenter: boolean;
	showTaskInfo: [number, 0 | 1 | 2, params?: any] | undefined;
	showDragFilesOverlay: boolean;
	paraSelected: number,
	draggerPos: number,
	taskViewSettings: {
		showParams: boolean,
		showDashboard: boolean,
		showCmd: boolean,
		cmdDisplay: 'input' | 'output',
		paramsVisibility: {
			duration: 'all' | 'input' | 'none',
			format: 'all' | 'input' | 'none',
			smpte: 'all' | 'input' | 'none',
			video: 'all' | 'input' | 'none',
			audio: 'all' | 'input' | 'none',
		},
	},
	frontendSettings: {
		colorTheme: string,
		useIEC: boolean,
		aiDisabled: boolean,
	},
	unreadNotificationCount: number,
	componentRefs: { [key: string]: VNodeRef | Element },
	// 非界面类
	notifications: Notification[],
	servers: Server[];
	currentServerId: string;
	selectedTask: Set<number>,
	taskSelectionModified: boolean;	// 修改参数后显示提示是否应用到所有任务，更改 selectedTask 时去除显示
	globalParams: OutputParams;
	presetName: string | undefined;
	availablePresets: string[];
	downloadMap: Map<string, string>;	// <url, serverId>
	latestVersion?: string;
	functionLevel: number;
}

// useStore 可以是 useUser、useCart 之类的任何东西
// 第一个参数是应用程序中 store 的唯一 id
export const useAppStore = defineStore('app', {
	// other options...
	// 推荐使用 完整类型推断的箭头函数
	state: (): StoreState => {
		return {
			// 所有这些属性都将自动推断其类型
			// 界面类
			showMenuCenter: 0,
			showInfoCenter: false,
			showTransferCenter: false,
			showTaskInfo: undefined,
			showDragFilesOverlay: false,
			paraSelected: 1,
			draggerPos: 0.57,
			taskViewSettings: {
				showParams: true,
				showDashboard: true,
				showCmd: true,
				cmdDisplay: 'input',
				paramsVisibility: {
					duration: 'none',
					format: 'none',
					smpte: 'none',
					video: 'none',
					audio: 'none',
				},
			},
			frontendSettings: {
				colorTheme: 'themeLight',
				useIEC: false,
				aiDisabled: false,
			},
			unreadNotificationCount: 0,
			componentRefs: {},
			// 非界面类
			notifications: [],
			servers: [],
			currentServerId: undefined,
			selectedTask: new Set(),
			taskSelectionModified: false,
			globalParams: JSON.parse(JSON.stringify(defaultParams)),
			presetName: '',
			availablePresets: [],
			downloadMap: new Map(),
			latestVersion: undefined,
			functionLevel: 20,
		};
	},
	getters: {
		currentServer: (state) => {
			return state.servers.find((server) => server.data.id === state.currentServerId);
		},
		localServer: (state) => {
			// app 初始化逻辑中会通过识别 nodeBridge.env 添加一个 localhost 服务器。除此以外没有添加 localhost 的渠道
			return state.servers.length && state.servers[0].entity.ip === 'localhost' ? state.servers[0] : undefined;
		},
	},
	actions: {
		// #region 纯 UI
		// #endregion 纯 UI
		// #region 任务处理
		/**
		 * 添加一系列任务。仅支持本地文件和远程路径，本地文件夹需展开后再传入，未知路径传入无效
		 * Promise 最终会在后端返回任务更新（或 200ms 超时）后，并将 globalParams 替换后 resolve
		 */
		addTasks (inputList: string[] | FileList, type: 'multiTask' | 'multiInput' = 'multiTask') {
			return new Promise(async (resolve) => {
				function allTimerFinish() {
					Promise.all(newlyAddedTaskIds).then((ids) => {
						// 从 5.0 开始，由于支持多输入，addTask 函数向后端传的是替换了文件名的 globalParams，因此需要 applySelectedTask 使参数变成当前选中的 task 的参数，否则不一致
						// 需要等待一次 taskUpdate，待另一个监听器替换了任务参数之后，再在此处 applySelectedTask，否则会导致参数为空
						// 由于网络到达顺序的不确定性，Promise 完成时可能所有任务都完成了 taskUpdate，此时再加监听器则无法触发。因此需要加一个 timeout 做兜底
						const handler = () => {
							clearTimeout(timer);
							server.entity.off('taskUpdate', handler);
							这.selectedTask = new Set(ids);
							这.applySelectedTask();
							resolve(ids);
						};
						const timer = setTimeout(handler, 200);
						server.entity.on('taskUpdate', handler);
					});
				}
	
				const 这 = useAppStore();
				const server = 这.currentServer;
				const isRemoteService = server.entity.ip !== 'localhost';
				const newlyAddedTaskIds: Promise<number>[] = [];	// 考虑到 timer 的最后一项并不一定是网络到达的最后一项，这里使用 Promise。待后期远程调用批量化后可改进
				let dropDelayCount = 0;
				const maxTaskCount = getLimitaion('maxTaskListCount');

				if (type === 'multiTask') {
					let needStopCuzLimit = false;	// 因为使用了 setTimeout，所以使用标记位停止后续添加
					for (const input of inputList) {
						setTimeout(async () => {	// v2.4 版本开始完全可以不要延时，但是太生硬，所以加个动画
							if (needStopCuzLimit) {
								return;
							}
							if (Object.keys(server.data.tasks).length - 1 >= maxTaskCount) {	// 全局任务占了一个位置
								needStopCuzLimit = true;
								这.pushMsg(
									`😞任务数量达到上限了（前端）\n` +
									`💔您的用户等级最高支持在任务列表中放入 ${maxTaskCount} 个任务，您可以先删除一些任务再添加\n` +
									'🤫开发者设计该项限制的意图是避免超出合理范围的操作导致前端卡顿（实测 100 个任务同时运行一遍或能导致前端卡顿半小时），\n' +
									'　并给“伸手党”和“白嫖党”制造一些不便😞谁知盘中餐，粒粒皆辛苦！\n' +
									'☺️探访一下 FFBox 官网或作者发布媒介，或许就能发现激活方式了✅',	
									NotificationLevel.warning
								);
								allTimerFinish();
								return;
							}
							const fileBaseName = typeof input === 'string' ? path.parse(input.replaceAll('\\', '/')).base : input.name;
							const fileType = typeof input === 'string' ? (await nodeBridge.getPathsCategorized(input)).lineResults?.[0] : 'lf';
							const needUpload = fileType === 'lf' && isRemoteService;	// 网页版必定是 remoteService；如果拖入的是文件而不是字符串那么必定是 lf（以后再支持文件夹拖入）
							// console.log('添加任务', input, fileType);
							if (needUpload) {
								const limitedFileSizeGB = getLimitaion('maxUploadSizeGB');
								const fileSize = typeof input === 'string' ? (await nodeBridge.getLocalFileStats(input)).size : input.size;
								if (fileSize > limitedFileSizeGB * 1000 * 1000 * 1000) {
									Popup({
										message: `${fileBaseName} 文件大小超过 ${limitedFileSizeGB} GB，暂不支持上传操作`,
										level: 2,
									});
									return;
								}
							}
							const inputName = `[uploading] ${fileBaseName}`
							let promise: Promise<number> = 这.addTask(
								trimExt(fileBaseName),
								[needUpload ? inputName : (typeof input === 'string' ? input : input.path)]
							);	// 网页版拖入文件必定上传，electron 版拖入文件则直接以路径输入
							if (needUpload) {
								// addTask 后，后端通过发送一个 tasklistUpdate 来使前端更新任务列表，然后 resolve 掉 addTask 请求。由于上传过程并不会访问 task，故哪怕网络到达顺序不对，这里也不会出错
								promise.then(async (taskId) => {
									const file = await addUploadTask(server as any, input, taskId, fileBaseName, inputName);
									server.data.uploadFiles.push(file);
								});
							}
							newlyAddedTaskIds.push(promise);
							if (newlyAddedTaskIds.length === inputList.length) {
								allTimerFinish();
							}
						}, dropDelayCount);
						// console.log(dropDelayCount)
						dropDelayCount += 33.33;
					}
				} else if (type === 'multiInput') {
					if (Object.keys(server.data.tasks).length - 1 >= maxTaskCount) {	// 全局任务占了一个位置
						这.pushMsg(
							`😞任务数量达到上限了（前端）\n` +
							`💔您的用户等级最高支持在任务列表中放入 ${maxTaskCount} 个任务，您可以先删除一些任务再添加\n` +
							'🤫开发者设计该项限制的意图是避免超出合理范围的操作导致前端卡顿（实测 100 个任务同时运行一遍或能导致前端卡顿半小时），\n' +
							'　并给“伸手党”和“白嫖党”制造一些不便😞谁知盘中餐，粒粒皆辛苦！\n' +
							'☺️探访一下 FFBox 官网或作者发布媒介，或许就能发现激活方式了✅',	
							NotificationLevel.warning
						);
						allTimerFinish();
						return;
					}
	
					/**
					 * 本地：无需上传，字符串原样传入，File 读取 .path
					 * 远程：字符串判断是文件（非文件夹）后生成 inputName 占位符后上传，文件直接上传（丢文件夹会失败）
					 */
					// 先添加占位符任务，然后检查上传
					const firstFileBaseName = typeof inputList[0] === 'string' ? path.parse(inputList[0])?.name : inputList[0]?.name;
					const taskId = await 这.addTask(
						firstFileBaseName ? trimExt(firstFileBaseName) : `新任务 ${new Date().toISOString()}`,
						[]
					);
					newlyAddedTaskIds.push(Promise.resolve(taskId));

					const inputPaths: string[] = [];
					for (const input of inputList) {
						const fileBaseName = typeof input === 'string' ? path.parse(input.replaceAll('\\', '/')).base : input.name;
						const fileType = typeof input === 'string' ? (await nodeBridge.getPathsCategorized(input)).lineResults?.[0] : 'lf';
						const needUpload = fileType === 'lf' && isRemoteService;	// 网页版必定是 remoteService；如果拖入的是文件而不是字符串那么必定是 lf（以后再支持文件夹拖入）
						// console.log('添加任务', input, fileType);
						if (needUpload) {
							const limitedFileSizeGB = getLimitaion('maxUploadSizeGB');
							const fileSize = typeof input === 'string' ? (await nodeBridge.getLocalFileStats(input)).size : input.size;
							if (fileSize > limitedFileSizeGB * 1000 * 1000 * 1000) {
								Popup({
									message: `${fileBaseName} 文件大小超过 ${limitedFileSizeGB} GB，暂不支持上传操作`,
									level: 2,
								});
								continue;
							}
						}
						if (needUpload) {
							const inputName = `[uploading] ${fileBaseName}`
							const file = await addUploadTask(server as any, input, taskId, fileBaseName, inputName);
							server.data.uploadFiles.push(file);
							inputPaths.push(inputName);
						} else {
							inputPaths.push(typeof input === 'string' ? input : input.path);
						}
						// inputPaths.push(input);
						// inputPaths.push(input.path);
					}

					// 完成任务添加后，设置输入列表
					const entity = 这.currentServer?.entity;
					const params = 这.globalParams;
					entity.setParameters([taskId], [{
						...params,
						input: {
							files: inputPaths.map((path, index) => ({
								filePath: path.replace(/\\/g, '/'),
								demuxer: params.input.files[index]?.demuxer ?? '自动',
								begin: params.input.files[index]?.begin ?? '',
								end: params.input.files[index]?.end ?? '',
								hwaccel: params.input.files[index]?.hwaccel ?? '自动',
								realtime: params.input.files[index]?.realtime ?? false,
								detail: params.input.files[index]?.realtime ?? {},
								custom: params.input.files[index]?.custom ?? '',
							})),
						},
					}]);
					allTimerFinish();
				}
			});
		},
		/**
		 * 添加任务
		 * path 将自动添加到 params 中去
		 * @param path 输入文件的路径。若为远程任务则需定义一个占位符，完成上传后通过 service.mergeUploaded 修正文件名
		 */
		addTask(fileName: string, paths: string[]): Promise<number> {
			const 这 = useAppStore();
			const currentBridge = 这.currentServer?.entity;
			if (!currentBridge) {
				return;
			}
			const params: OutputParams = JSON.parse(JSON.stringify(这.globalParams));
			params.input.files = paths.map((path, index) => ({
				filePath: path ? path.replace(/\\/g, '/') : undefined,
				demuxer: params.input.files[index]?.demuxer ?? '自动',
				begin: params.input.files[index]?.begin ?? '',
				end: params.input.files[index]?.end ?? '',
				hwaccel: params.input.files[index]?.hwaccel ?? '自动',
				realtime: params.input.files[index]?.realtime ?? false,
				detail: params.input.files[index]?.detail ?? {},
				custom: params.input.files[index]?.custom ?? '',
			}));
			const result = currentBridge.taskAdd(fileName, params);
			return result;
		},
		/**
		 * 获取 service 的 taskList 更新到本地
		 */
		updateTaskList(server: Server) {
			const 这 = useAppStore();
			server.entity.getTaskList().then((content) => {
				handleTasklistUpdate(server, content);
				这.recalcChangedParams();
			});
		},
		/**
		 * 获取 service 的 task 更新到本地
		 */
		updateTask(server: Server, taskId: number) {
			const 这 = useAppStore();
			server.entity.getTask(taskId).then((content) => {
				handleTaskUpdate(server, taskId, content);
				这.recalcChangedParams();
			});
		},
		/**
		 * 检查每个任务的上传状态，调用 entity.deleteTask
		 * @param taskIds 
		 */
		deleteTasks(taskIds: number[]) {
			const 这 = useAppStore();
			for (const taskId of taskIds) {
				const uploadFiles = 这.currentServer.data.uploadFiles.filter((uploadFile) => uploadFile.taskId === taskId)
				for (const uploadFile of uploadFiles) {
					// 对于正在读取校验的任务
					uploadFile.readTask?.stop();	// 不一定有，比如上传完成
					// 对于正在上传的任务
					const uploadingChunks = uploadFile.chunks.filter((chunk) => chunk.status === 'uploading'); 
					uploadingChunks.forEach((chunk) => chunk.abortController.abort());
				}
				这.currentServer.entity.taskDelete(taskId);
			}
		},
		/**
		 * 修改已选任务项后调用
		 * 函数将使用已选择的任务项替换 globalParameters
		 */
		applySelectedTask() {
			const 这 = useAppStore();
			if (这.selectedTask.size > 0) {
				for (const id of 这.selectedTask) {
					这.globalParams = replaceOutputParams(这.currentServer.data.tasks[id].after, 这.globalParams, true);
				}
			}
			这.globalParams.extra.presetName = '';
			这.presetName = '';
		},
		startNpause () {
			const 这 = useAppStore();
			if (这.currentServer.entity.status !== ServiceBridgeStatus.Connected) {
				return;
			}
			const data = 这.currentServer.data;
			const entity = 这.currentServer.entity;
			if (data.workingStatus === WorkingStatus.idle) {		// 开始任务
				entity.queueStart();
			} else {
				entity.queuePause();
			}
		},
		// #endregion 任务处理
		// #region 参数处理
		/**
		 * 修改 globalParams 后需调用此函数
		 * 函数将修改后的全局参数应用到当前选择的任务项，然后保存到本地磁盘
		 * 对于用户操作，将预设参数置为未保存
		 */
		applyParameters(behavior: 'modifyTask' | 'applyToAllTasks' | 'loadPreset' | 'verifyDefaults' = 'modifyTask', selection?: Set<number>) {
			const 这 = useAppStore();
			// 更改到一些不匹配的值后会导致 getFFmpegParaArray 出错，但是修正代码就在后面，因此仅需忽略它，让它继续运行下去，不要急着更新

			// 变更预设参数
			if (behavior === 'modifyTask') {
				这.globalParams.extra.presetName = '';
				这.presetName = '';
			}

			const entity = 这.currentServer?.entity;
			const data = 这.currentServer?.data;
			if (data) {
				// 这.globalParams
				// 收集需要批量更新的输出参数，交给 service。同时本地替换一次 task.after
				let needToUpdateIds: number[] = [];
				let needToUpdateParams: OutputParams[] = [];
				for (const id of selection || 这.selectedTask) {
					let task = data.tasks[id];
					const needToReplaceAll = behavior === 'modifyTask' && 这.selectedTask.size === 1;
					task.after = replaceOutputParams(这.globalParams, task.after, needToReplaceAll);
					needToUpdateIds.push(id);
					needToUpdateParams.push(task.after);
				}
				if (needToUpdateIds.length) {
					// paraArray 由 service 算出后回填本地
					// 更新方式是 taskUpdate
					// 注意回填本地时也会产生一次 task.after 更新
					entity.setParameters(needToUpdateIds, needToUpdateParams);
				}

				这.taskSelectionModified = true;
			}

			// 存盘
			clearTimeout((window as any).saveAllParaTimer);
			(window as any).saveAllParaTimer = setTimeout(() => {
				nodeBridge.localStorage.set('globalParams', 这.globalParams);
				console.log('参数已保存');
			}, 700);
		},
		/**
		 * 切换编码器之后或者第一次使用 FFBox 需要预置一些默认值，通过调用此函数进行
		 * 并会调用一次 applyParameters 以存储并将当前配置应用到所选任务上
		 */
		checkAndApplyCodecDefaults(who: { video?: true, audio?: true, mux?: true }, outputIndex = 0) {
			const 这 = useAppStore();
			if (who.video) {
				const v = 这.globalParams.outputs[outputIndex].video;
				const vcodec = getMenuItemByValue(builtInVcodecs, v.vcodec) ?? getMenuItemByValue(allVcodecs, v.vcodec)
				for (const parameter of ((vcodec as any)?.extra?.parameters || [])) {
					if (parameter.optional) {
						continue;	// 默认不启用可选参数。在勾选后才读取默认值
					}
					if (parameter.mode === 'combo') {
						const defaultValue = parameter.default ?? parameter.items[0].value;
						console.log(`参数 ${parameter.parameter} 重置为默认值或首项：${defaultValue}`);
						v.detail[parameter.parameter] = defaultValue;
					} else if (parameter.mode == 'slider') {
						const defaultValue = parameter.default ?? ((parameter.max ?? 1) + (parameter.min ?? 0)) / 2;
						console.log(`参数 ${parameter.parameter} 重置为默认值或中间值：${defaultValue}`);	// 假定所有 string 类的 slider 都必须定义 default
						v.detail[parameter.parameter] = defaultValue;
					}
				}
			}
			if (who.audio) {
				const a = 这.globalParams.outputs[outputIndex].audio;
				const acodec = getMenuItemByValue(builtInAcodecs, a.acodec) ?? getMenuItemByValue(allAcodecs, a.acodec)
				for (const parameter of ((acodec as any)?.extra?.parameters || [])) {
					if (parameter.optional) {
						continue;	// 默认不启用可选参数。在勾选后才读取默认值
					}
					if (parameter.mode === 'combo') {
						const defaultValue = parameter.default ?? parameter.items[0].value;
						console.log(`参数 ${parameter.parameter} 重置为默认值或首项：${defaultValue}`);
						a.detail[parameter.parameter] = defaultValue;
					} else if (parameter.mode == 'slider') {
						const defaultValue = parameter.default ?? ((parameter.max ?? 1) + (parameter.min ?? 0)) / 2;
						console.log(`参数 ${parameter.parameter} 重置为默认值或中间值：${defaultValue}`);	// 假定所有 string 类的 slider 都必须定义 default
						a.detail[parameter.parameter] = defaultValue;
					}
				}
			}
			if (who.mux) {
				const m = 这.globalParams.outputs[outputIndex].mux;
				const muxer = getMenuItemByValue(builtInMuxers, m.format) ?? getMenuItemByValue(allMuxers, m.format)
				for (const parameter of ((muxer as any)?.extra?.parameters || [])) {
					if (parameter.optional) {
						continue;	// 默认不启用可选参数。在勾选后才读取默认值
					}
					if (parameter.mode === 'combo') {
						const defaultValue = parameter.default ?? parameter.items[0].value;
						console.log(`参数 ${parameter.parameter} 重置为默认值或首项：${defaultValue}`);
						m.detail[parameter.parameter] = defaultValue;
					} else if (parameter.mode == 'slider') {
						const defaultValue = parameter.default ?? ((parameter.max ?? 1) + (parameter.min ?? 0)) / 2;
						console.log(`参数 ${parameter.parameter} 重置为默认值或中间值：${defaultValue}`);	// 假定所有 string 类的 slider 都必须定义 default
						m.detail[parameter.parameter] = defaultValue;
					}
				}
			}
			这.applyParameters('verifyDefaults');
		},
		/**
		 * 检查有多少参数是非“不重新编码”的，以此更改界面显示形式（paramsVisibility）
		 * 在服务器初次加载和修改参数时调用
		 * 目前均以第一个输入和第一个输出的参数为准
		 */
		recalcChangedParams() {
			const 这 = useAppStore();
			const paramsVisibility = {
				duration: 0,
				format: 0,
				smpte: 0,
				video: 0,
				audio: 0,
			};
			for (const [index, task] of Object.entries(这.currentServer?.data.tasks) || []) {
				if (index === '-1' || task.after.input.files.length !== 1 || task.after.outputs.length !== 1) {
					continue;
				}
				const after = task.after;
				if (after.input.files[0].begin || after.input.files[0].end || after.outputs[0].mux.begin || after.outputs[0].mux.end) {
					paramsVisibility.duration = Math.max(paramsVisibility.duration, 2);
				} else {
					paramsVisibility.duration = Math.max(paramsVisibility.duration, 1);
				}
				if (after.outputs[0].mux.format === '无' || after.outputs[0].mux.format === task.before[0]?.demuxer) {
					paramsVisibility.format = Math.max(paramsVisibility.format, 1);
				} else {
					paramsVisibility.format = Math.max(paramsVisibility.format, 2);
				}
				if (after.outputs[0].video.vcodec !== '禁用视频') {
					if (after.outputs[0].video.vcodec !== '不重新编码') {
						paramsVisibility.video = Math.max(paramsVisibility.video, 2);
						if (after.outputs[0].video.resolution !== '不改变' || task.after.outputs[0].video.framerate !== '不改变') {
							paramsVisibility.smpte = Math.max(paramsVisibility.smpte, 2);
						} else {
							paramsVisibility.smpte = Math.max(paramsVisibility.smpte, 1);
						}
					} else {
						paramsVisibility.video = Math.max(paramsVisibility.video, 1);
					}
				}
				if (after.outputs[0].audio.acodec !== '禁用音频') {
					if (after.outputs[0].audio.acodec !== '不重新编码') {
						paramsVisibility.audio = Math.max(paramsVisibility.audio, 2);
					} else {
						paramsVisibility.audio = Math.max(paramsVisibility.audio, 1);
					}
				}
			}
			const newVisibility = {
				duration: (['none', 'input', 'all'] as any)[paramsVisibility.duration],
				format: (['none', 'input', 'all'] as any)[paramsVisibility.format],
				smpte: (['none', 'input', 'all'] as any)[paramsVisibility.smpte],
				video: (['none', 'input', 'all'] as any)[paramsVisibility.video],
				audio: (['none', 'input', 'all'] as any)[paramsVisibility.audio],
			};
			if (
				这.taskViewSettings.paramsVisibility.duration !== newVisibility.duration ||
				这.taskViewSettings.paramsVisibility.format !== newVisibility.format ||
				这.taskViewSettings.paramsVisibility.smpte !== newVisibility.smpte ||
				这.taskViewSettings.paramsVisibility.video !== newVisibility.video ||
				这.taskViewSettings.paramsVisibility.audio !== newVisibility.audio
			) {
				这.taskViewSettings.paramsVisibility = newVisibility;
			}
			// 这.taskViewSettings.paramsVisibility = {
			// 	duration: (['none', 'input', 'all'] as any)[paramsVisibility.duration],
			// 	format: (['none', 'input', 'all'] as any)[paramsVisibility.format],
			// 	smpte: (['none', 'input', 'all'] as any)[paramsVisibility.smpte],
			// 	video: (['none', 'input', 'all'] as any)[paramsVisibility.video],
			// 	audio: (['none', 'input', 'all'] as any)[paramsVisibility.audio],
			// };
			// console.log('recalcChangedParams', 这.taskViewSettings.paramsVisibility);
		},
		/**
		 * 按名称载入预设并更新配置（含所选任务配置）
		 */
		async loadPreset(name: string) {
			const 这 = useAppStore();
			if (name === '默认配置') {
				这.globalParams = JSON.parse(JSON.stringify(defaultParams));
				这.presetName = name;
				这.checkAndApplyCodecDefaults({ video: true, audio: true });
			} else {
				const params = await nodeBridge.localStorage.get(`presets.${name}`);
				if (params) {
					这.globalParams = params;
				}
				这.presetName = name;
				这.applyParameters('loadPreset');
			}
			if (这.selectedTask.size > 0) {
				// 这个操作约等于 applySelectedTask
				// 主要目的是，当选中了任务更改预设时，全局参数中的输入文件名等信息会被替换，但任务中的不被替换。若马上就修改其他参数，会导致任务中的输入文件名等信息变成全局的
				const fisrtSelectedTaskId = [...这.selectedTask][0];
				这.globalParams = replaceOutputParams(这.currentServer.data.tasks[fisrtSelectedTaskId].after, 这.globalParams, true);
			}
		},
		savePreset(name: string) {
			const 这 = useAppStore();
			return nodeBridge.localStorage.set(`presets.${name}`, 这.globalParams).then(() => {
				这.presetName = name;
				这.loadPresetList();
			});
		},
		editPreset(oldName: string, newName: string) {
			const 这 = useAppStore();
			async function f() {
				const oldPreset = await nodeBridge.localStorage.get(`presets.${oldName}`);
				nodeBridge.localStorage.set(`presets.${newName}`, oldPreset);
				if (newName !== oldName) {
					nodeBridge.localStorage.delete(`presets.${oldName}`);
				}
				这.presetName = newName;
				这.loadPresetList();
			}
			return f();
		},
		deletePreset(name: string) {
			const 这 = useAppStore();
			return nodeBridge.localStorage.delete(`presets.${name}`).then(() => {
				这.presetName = '';
				这.loadPresetList();
			});
		},
		/**
		 * 通过 electronStore.get('presets') 得到的 key 更新当前可用的预设菜单
		 */
		loadPresetList() {
			const 这 = useAppStore();
			nodeBridge.localStorage.get('presets').then((presets) => {
				try {
					这.availablePresets = Object.keys(presets);
				} catch (error) {
					nodeBridge.localStorage.set('presets', {});
				}
			});
		},
		fetchAVOptions() {
			const 这 = useAppStore();
			const entity = 这.currentServer?.entity;
			if (entity?.status === ServiceBridgeStatus.Connected) {
				entity.getAVOptions().then((result: { codecs: { video: FFmpegCodecDetail[], audio: FFmpegCodecDetail[] }, formats: { muxer: FFmpegMuxerDetail[], demuxer: FFmpegDemuxerDetail[] }, filters: FFmpegFilterDetail[] }) => {
					parseFFmpegCodecsToCodecsList(result.codecs);
					parseFFmpegFiltersToFiltersList(result.filters);
					parseFFmpegMuDeMuxersToList(result.formats);
					nodeBridge.localStorage.set('ffmpegCodecs', result.codecs);
					nodeBridge.localStorage.set('ffmpegFormats', result.formats);
					nodeBridge.localStorage.set('ffmpegFilters', result.filters);
					Popup({ message: `已获取来自 ${这.currentServer.data.name} ffmpeg 的 ${result.codecs.video.length} 种视频编码、${result.codecs.audio.length} 种音频编码、${result.formats.demuxer.length} 个解复用器、${result.formats.muxer.length} 个复用器、${result.filters.length} 个滤镜`, level: NotificationLevel.ok });
					window?.dispatchEvent(new CustomEvent('finished-fetch-codecs'));
				});
			} else {
				Popup({ message: '请先连接当前标签的服务器', level: NotificationLevel.error });
			}
		},
		// #endregion 参数处理
		// #region 通知处理
		/**
		 * 获取 service 的 notifications 更新到本地
		 */
		updateNotifications(server: Server) {
			const 这 = useAppStore();
			const entity = 这.currentServer?.entity;
			entity.getNotifications().then((result) => {
				server.data.notifications = result;
			});
		},
		pushMsg(message: string, level: NotificationLevel) {
			const 这 = useAppStore();
			Popup({ message, level });
			这.notifications.push({
				time: new Date().getTime(),
				content: message,
				level,
			})
		},
		setUnreadNotifationCount(clear = false) {
			const 这 = useAppStore();
			这.unreadNotificationCount = clear ? 0 : 这.unreadNotificationCount + 1;
		},
		// #endregion 通知处理
		// #region 服务器处理
		/**
		 * 获取 service 的版本和属性更新到本地
		 */
		updateServerProperties(server: Server) {
			const 这 = useAppStore();
			Promise.all([
				fetch(`http://${server.entity.ip}:${server.entity.port}/version`, { method: 'get' }),
				server.entity.getProperties(),
				server.entity.getWorkingStatus(),
			]).then(([versionResponse, properties, workingStatus]) => {
				versionResponse.text().then((text) => {
					server.data.version = text;
					if (['3.0', '4.0', '4.1', '4.2', '4.3', '4.4', '4.5', '5.0'].includes(text)) {
						// 4.3 版本更新了任务管理方式
						// 5.0 版本更新了任务参数数据结构
						// 5.1 版本更新了任务名
						Popup({ message: `服务器版本 ${text} 与客户端版本 ${version} 不兼容，请更换服务器或客户端`, level: NotificationLevel.warning });
					} else if (text !== version) {
						Popup({ message: `服务器版本 ${text} 与客户端版本不匹配，可能会导致部分操作异常，请谨慎操作`, level: NotificationLevel.warning });
					}
				});

				// properties
				server.data.os = properties.os;
				server.data.isSandboxed = properties.isSandboxed;
				server.data.machineId = properties.machineId;
				server.data.functionLevel = properties.functionLevel;
				server.data.ffmpegInfo = properties.ffmpegInfo;

				// workingStatus
				if (workingStatus === WorkingStatus.idle || workingStatus === WorkingStatus.running) {
					server.data.workingStatus = workingStatus;
				}
			});
		},
		/**
		 * 添加服务器标签页
		 */
		addServer() {
			const 这 = useAppStore();
			const id = randomString(6);
			这.servers.push({
				data: {
					id: id,
					name: '未连接',
					tasks: [],
					notifications: [],
					uploadFiles: [],
					downloadFiles: [],
					ffmpegInfo: { version: '', scanning: false, videoEncodersCount: 0, audioEncodersCount: 0, muxersCount: 0, demuxersCount: 0, filtersCount: 0 },
					version: '',
					workingStatus: WorkingStatus.idle,
					progress: 0,
					overallProgressTimerID: NaN,
				},
				entity: new ServiceBridge(),
			});
			这.currentServerId = id;
			return id;
		},
		/**
		 * 关闭服务器标签页
		 * TODO 暂未实现上传下载中断逻辑
		 */
		removeServer(serverId: string) {
			const 这 = useAppStore();
			const index = 这.servers.findIndex((server) => server.data.id === serverId);
			if (index > -1) {
				这.servers.splice(index, 1);
			}
			if (这.currentServerId === serverId) {
				这.currentServerId = 这.servers[index - 1].data.id;
			}
		},
		/**
		 * 初始化服务器连接并挂载事件监听
		 */
		initializeServer(serverId: string, ip: string, port: number, username: string, password: string, retryCount = 0) {
			const 这 = useAppStore();
			const server = 这.servers.find((server) => server.data.id === serverId) as Server;
			const entity = server.entity;
			if (!ip) {
				return Promise.reject();
			}
			const _port = port ?? 33269;
			console.log('初始化服务器连接', server.data);

			const destroy = () => {
				for (const eventName of ['connected', 'disconnected', 'error', 'ffmpegInfo', 'workingStatusUpdate', 'tasklistUpdate', 'taskUpdate', 'cmdUpdate', 'progressUpdate', 'taskNotification'] as any[]) {
					entity.removeAllListeners(eventName);
				}
			}
			return new Promise((resolve, reject) => {
				entity.connect(ip, _port, username, password);
	
				entity.on('connected', () => {
					server.data.name = ip === 'localhost' ? '本地服务器' : ip;
					console.log(`成功连接到服务器 ${server.entity.ip}`);
					这.pushMsg(`成功连接到服务器 ${server.data.name}`, NotificationLevel.ok);
					server.data.tasks = [];	// 由于 taskList 只包含 id，重新连接后需要清除原 task 信息以获取新的
					这.updateServerProperties(server);
					这.updateTaskList(server);
					// entity.updateTaskList();
					这.updateNotifications(server);
					resolve(server);
				});
				entity.on('disconnected', () => {
					console.log(`已断开服务器 ${server.entity.ip} 的连接`);
					这.pushMsg(`已断开服务器 ${server.data.name} 的连接`, NotificationLevel.warning);
					destroy();
				});
				entity.on('error', (reason) => {
					if (!retryCount || reason.includes('连接失败')) {
						console.log(`服务器 ${server.entity.ip} ${reason}`);
						这.pushMsg(`服务器 ${server.data.name} ${reason}`, NotificationLevel.error);
						destroy();
						reject(reason);
					} else {
						console.log(`服务器 ${server.entity.ip} ${reason}，剩余重试次数 ${retryCount}`);
						setTimeout(() => {
							这.initializeServer(serverId, ip, port, username, password, retryCount - 1);
						}, 150);
					}
				});
	
				entity.on('ffmpegInfo', (data) => {
					handleFFmpegInfo(server, data);
				});
				entity.on('workingStatusUpdate', (data) => {
					handleWorkingStatusUpdate(server, data.value);
				});
				entity.on('tasklistUpdate', (data) => {
					handleTasklistUpdate(server, data.content);
					这.recalcChangedParams();
				});
				entity.on('taskUpdate', (data) => {
					handleTaskUpdate(server, data.taskId, data.task);
					这.recalcChangedParams();
				});
				entity.on('cmdUpdate', (data) => {
					handleCmdUpdate(server, data.taskId, data.content, data.append);
				});
				entity.on('progressUpdate', (data) => {
					handleProgressUpdate(server, data.taskId, data.time, data.status, 这.functionLevel);
				});
				entity.on('notificationUpdate', (data) => {
					handleNotificationUpdate(server, data.notificationId, data.notification);
				});
			});
		},
		/**
		 * 重新连接已掉线或未成功连接的服务器
		 */
		reConnectServer(serverId: string) {
			const 这 = useAppStore();
			const server = 这.servers.find((server) => server.data.id === serverId) as Server;
			const entity = server.entity;
			这.initializeServer(serverId, entity.ip, entity.port, entity.username, entity.password);
		},
		// #endregion 服务器处理
		// #region 其他
		async activateBackend(userInput: string): Promise<number | false> {
			const 这 = useAppStore();
			const result = await 这.currentServer?.entity.activate(userInput);
			if (result && Number.isFinite(+result)) {
				这.currentServer!.data.functionLevel = +result;
				return +result;
			}
			return false;
		},
		async activateFrontend(userInput: string): Promise<number | false> {
			const 这 = useAppStore();
			if (nodeBridge.env === 'electron') {
				/**
				 * 客户端和管理端均使用机器码 + 固定码共 32 位作为 key
				 * 管理端使用这个 key 对 functionLevel 加密，得到的加密字符串由用户输入到 userInput 中去
				 * 客户端将 userInput 使用 key 解密，如果 userInput 不是瞎编的，那么就能解出正确的 functionLevel
				 */
				const machineId = await nodeBridge.getMachineId();
				const fixedCode = 'd324c697ebfc42b7';
				const key = machineId + fixedCode;
				const decrypted = CryptoJS.AES.decrypt(userInput, key)
				const decryptedString = CryptoJS.enc.Utf8.stringify(decrypted);
				if (parseInt(decryptedString).toString() === decryptedString) {
					这.functionLevel = parseInt(decryptedString);
					nodeBridge.localStorage.set('frontendSettings.activationCode', userInput);
					return parseInt(decryptedString);
				} else {
					return false;
				}
			}
		},
		/**
		 * 修改前端设置后调用
		 * 函数将修改后的全局参数应用到当前选择的任务项，然后保存到本地磁盘
		 * 对于用户操作，进行存盘
		 */
		applyFrontendSettings(isUserInteraction: boolean) {
			const 这 = useAppStore();

			if (isUserInteraction) {
				// 存盘
				clearTimeout((window as any).saveAllParaTimer);
				(window as any).saveAllParaTimer = setTimeout(() => {
					nodeBridge.localStorage.set('frontendSettings', 这.frontendSettings);
					console.log('设置已保存');
				}, 700);
			}

			document.body.className = 这.frontendSettings.colorTheme;
			if (这.frontendSettings.colorTheme === 'themeAcrylic') {
				nodeBridge.setBlurBehindWindow(true);
			} else {
				nodeBridge.setBlurBehindWindow(false);
			}
			// document.body.setAttribute('data-color_theme', 这.frontendSettings.colorTheme);

			window.frontendSettings.useIEC = 这.frontendSettings.useIEC;
		},
		
		// #endregion 其他
	},
});
