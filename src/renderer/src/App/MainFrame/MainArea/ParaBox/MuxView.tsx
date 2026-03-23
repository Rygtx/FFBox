import { computed, defineComponent, ref } from 'vue';
import { allMuxers, builtInMuxers, Muxer, keepFileTimeList, keepMeatadataList } from '@common/params/formats'
import { durationFixer, durationValidator, getValidator, notEmptyValidator } from '../../../../components/validatorAndFixer';
import { getMenuItemByValue } from '@common/menu';
import { useAppStore } from '@renderer/stores/appStore';
import { renderDetailParameters } from './utils';
import AutoSizeWrapper from '@renderer/components/AutoSizeWrapper/AutoSizeWrapper.vue';
import Button, { ButtonType } from '@renderer/components/Button/Button';
import BoxedDropdownInput from '@renderer/components/DropdownInput/BoxedDropdownInput.vue';
import BoxedNormalInput from '@renderer/components/NormalInput/BoxedNormalInput.vue';
import ImageFind from './find.svg?component';
import css from './index.module.less';

interface Props {
	editingOutputIndex: number;
}

const MuxView = defineComponent((props: Props) => {
	const appStore = useAppStore();
	const showDetailParams = ref(true);

	const muxParams = computed(() => appStore.globalParams.outputs[props.editingOutputIndex]?.mux);
	
	const muxContainsInOutput = computed(() => {
		// 如果启用了滤镜，那么需要找到对应输出节点，并且有连线；否则默认输出一个文件
		if (appStore.globalParams.filter.nodes.length) {
			const outputNode = appStore.globalParams.filter.nodes.find((node) => node.name === `out_${props.editingOutputIndex}`);
			return outputNode?.prevs.length ? true : false;
		} else {
			return true;
		}
	});

	const combinedMuxersList = computed(() => (
		[
			...builtInMuxers,
			{ type: 'separator' },
			{ type: 'submenu', label: '全部可用复用器', subMenu: [
				{ type: 'normal', label: '从服务器获取', value: 'fetchFromService', icon: <span>🔄️</span>, onClick: () => {
					appStore.fetchAVOptions();
				} },
				...(allMuxers.length ? [{ type: 'separator' }] : []),
				...allMuxers,
			] },
		] as typeof builtInMuxers
	));

	const muxer = computed(() => {
		if (muxParams.value) {
			const muxerName = muxParams.value.format;
			return (getMenuItemByValue(combinedMuxersList.value, muxerName) as any)?.extra as Muxer;
		}
	});

	const handleChange = (sName: string, value: any) => {
		// @ts-ignore
		muxParams.value[sName] = value;
		appStore.applyParameters();
		if (sName == 'format') {
			appStore.checkAndApplyCodecDefaults({ mux: true });
		}
	}
	const handleDetailChange = (sName: string, value: any) => {
		if (!muxParams.value.detail) muxParams.value.detail = {};
		muxParams.value.detail[sName] = value;
		appStore.applyParameters();
	}

	const handleApplyToAll = () => {
		const params = muxParams.value;
		for (const outputParams of appStore.globalParams.outputs) {
			outputParams.mux = JSON.parse(JSON.stringify(params));
		}
	};

	return () => muxParams.value && muxContainsInOutput.value ? (
		<div class={css.container}>
			<BoxedDropdownInput title="容器/格式" text={muxParams.value.format} list={combinedMuxersList.value} onChange={(value: string) => handleChange('format', value)} />
			{/* <BoxedSwitch title="元数据前移" checked={muxParams.value.moveflags} onChange={(value: boolean) => handleChange('moveflags', value)} /> */}
			<BoxedNormalInput title="剪辑起点" value={muxParams.value.begin} onChange={(value: string) => handleChange('begin', value)} validator={durationValidator} inputFixer={durationFixer} />
			<BoxedNormalInput title="剪辑终点" value={muxParams.value.end} onChange={(value: string) => handleChange('end', value)} validator={durationValidator} inputFixer={durationFixer} />
			{muxParams.value.format !== '无' && (
				<>
					<BoxedDropdownInput title="元数据保留" text={muxParams.value.keepMetadata || '无'} list={keepMeatadataList} onChange={(value: any) => handleChange('keepMetadata', value)} />
					<BoxedDropdownInput title="文件时间保留" description='FFBox 特色功能，对产出文件进行文件时间修改。对远程服务器任务暂不生效' text={muxParams.value.keepFileTime || '无'} list={keepFileTimeList} onChange={(value: any) => handleChange('keepFileTime', value)} />
					<BoxedNormalInput title="输出路径" value={muxParams.value.filePath} onChange={(value: string) => handleChange('filePath', value)} long={true} placeholder="[filedir]：文件所在目录；[filename]：文件基础名；[fileext]：文件扩展名" validator={notEmptyValidator} />
				</>
			)}
			<BoxedNormalInput title="自定义参数" value={muxParams.value.custom} onChange={(value: string) => handleChange('custom', value)} long={true} />
			{muxParams.value.format !== '无' && (
				<AutoSizeWrapper class={css.detailParameters} style={({ height }) => ({ height: showDetailParams.value ? `${height}px` : '42px' })} useResizeObserver={true}>
					<div class={css.bar}>
						<Button type={ButtonType.NoBg} onClick={() => showDetailParams.value = !showDetailParams.value}>点击{showDetailParams.value ? '隐藏' : '显示'}·详细参数</Button>
					</div>
					{renderDetailParameters(muxer.value?.parameters, muxParams.value.detail, (parameter, value: string) => handleDetailChange(parameter.parameter, value), true)}
					<div class={css.bar}>
						<Button type={ButtonType.NoBg} onClick={() => showDetailParams.value = !showDetailParams.value}>点击{showDetailParams.value ? '隐藏' : '显示'}·详细参数</Button>
					</div>
				</AutoSizeWrapper>
			)}
			{appStore.globalParams.outputs.length > 1 && (
				<div style={{ margin: '12px' }}>
					<Button onClick={handleApplyToAll}>
						应用封装参数到全部输出
					</Button>
				</div>			
			)}
		</div>
	) : (
		<div class={css.noOutput}>
			<div class={css.box}>
				<ImageFind />
				<div class={css.description}>
					<p>您正在编辑【输出 {props.editingOutputIndex}】的封装配置</p>
					<p>但【输出文件 {props.editingOutputIndex}】节点在滤镜图中不存在或未连接任何输入</p>
					<p>请先在“滤镜”面板中为该节点建立连线</p>
				</div>
			</div>
		</div>
	);
}, {
	props: ['editingOutputIndex'],
});

export default MuxView;
