import { computed, defineComponent, ref } from 'vue';
import { builtInAcodecs, volSlider, ACodecDetail, allAcodecs } from '@common/params/acodecs';
import { RateControl } from '@common/params/parameter';
import { allMuxers, builtInMuxers } from '@common/params/formats';
import { getMenuItemByValue } from '@common/menu';
import { useAppStore } from '@renderer/stores/appStore';
import { showLocalLibrary } from '@renderer/components/misc/LocalLibrary';
import { renderDetailParameters } from './utils';
import AutoSizeWrapper from '@renderer/components/AutoSizeWrapper/AutoSizeWrapper.vue';
import Button, { ButtonType } from '@renderer/components/Button/Button';
import BoxedDropdownInput from '@renderer/components/DropdownInput/BoxedDropdownInput.vue';
import BoxedNormalInput from '@renderer/components/NormalInput/BoxedNormalInput.vue';
import BoxedSlider from '@renderer/components/Slider/BoxedSlider.vue';
import ImageFind from './find.svg?component';
import css from './index.module.less';

interface Props {
	editingOutputIndex: number;
}

const AcodecView = defineComponent((props: Props) => {
	const appStore = useAppStore();
	const showDetailParams = ref(true);

	const audioParams = computed(() => appStore.globalParams.outputs[props.editingOutputIndex]?.audio);
	const muxerDefaultCodec = computed(() => {
		const muxParam = appStore.globalParams.outputs[props.editingOutputIndex]?.mux;
		if (muxParam) {
			let muxerItem = getMenuItemByValue(builtInMuxers, muxParam.format);
			if (!muxerItem) {
				muxerItem = getMenuItemByValue(allMuxers, muxParam.format);
			}
			if (muxerItem) {
				const audioMatch = muxerItem.tooltip.match(/默认音频编码器：(.+)/);
				return audioMatch?.[1] ? { muxer: muxParam.format, vcodec: audioMatch[1] } : undefined;
			}
		}
	});

	const audioContainsInOutput = computed(() => {
		// 如果启用了滤镜，那么需要找到对应输出节点，并且有连线；否则默认输出一个文件
		if (appStore.globalParams.filter.nodes.length) {
			const outputNode = appStore.globalParams.filter.nodes.find((node) => node.name === `out_${props.editingOutputIndex}`);
			return outputNode?.prevs.length ? true : false;
		} else {
			return true;
		}
	});

	const combinedVcodecsList = computed(() => (
		[
			{
				type: 'normal',
				value: '禁用',
				label: '禁用',
				tooltip: '不输出音频\n（如果输入中本来就没有音频，或者输出容器中不支持音频，ffmpeg 会自动忽略音频相关选项，您无需手动选择此处）',
			},
			{
				type: 'normal',
				value: 'copy',
				label: '不重新编码',
				tooltip: '复制源码流，不重新编码。',
			},
			{
				type: 'normal',
				value: '自动',
				label: muxerDefaultCodec.value ? `自动【${muxerDefaultCodec.value.vcodec}】` : '自动',
				tooltip: muxerDefaultCodec.value ? `不指定，让 ffmpeg 根据复用器默认设定选择编码\n根据你选择的复用器【${muxerDefaultCodec.value.muxer}】，默认使用【${muxerDefaultCodec.value.vcodec}】编码器` : '不指定，让 ffmpeg 根据复用器默认设定选择编码',
			},
			{ type: 'separator' },
			...builtInAcodecs,
			{ type: 'separator' },
			{ type: 'submenu', label: '全部可用编码', subMenu: [
				{ type: 'normal', label: '从服务器获取', value: 'fetchFromService', icon: <span>🔄️</span>, onClick: () => {
					appStore.fetchAVOptions();
				} },
				...(allAcodecs.length ? [{ type: 'separator' }] : []),
				...allAcodecs,
			] },
		] as typeof builtInAcodecs
	));

	const acodec = computed(() => {
		if (audioParams.value) {
			const acodecName = audioParams.value.acodec;
			return (getMenuItemByValue(combinedVcodecsList.value, acodecName) as any)?.extra as ACodecDetail;
		}
	});
	const rateControlList = computed(() => {
		return [
			...acodec.value.rateControl,
			// { type: 'separator' as const },
			// {
			// 	type: 'normal' as const,
			// 	value: 'fetchFromService',
			// 	label: '我应调整到什么值？...',
			// 	icon: <span>🤔</span>,
			// 	onClick: () => showLocalLibrary('FFBox 推荐画质设定'),
			// },
		];
	});
	// 根据当前选择的码率控制器显示具体使用何种 slider
	const rateControlSlider = computed(() => {
		const rList = acodec.value?.rateControl || [];
		if (!rList.length) {
			return null;
		}
		const rateControlName = audioParams.value.ratecontrol;
		let index = rList.findIndex((item) => item.type === 'normal' && item.value === rateControlName);
		// 切换编码器后没有原来的码率控制模式了，默认设定为列表第一项
		if (index == -1) {
			index = 0;
			audioParams.value.ratecontrol = (rList[0] as any).value;
			appStore.applyParameters();
		}
		const item = rList[index] as any;
		const slider = item.extra as RateControl;
		let title;
		switch (item.value) {
			case 'CBR/ABR':
				title = '码率'
				break;
			case 'Q':
				title = '质量参数'
				break;
		}
		return {
			title,
			min: slider.min,
			max: slider.max,
			arrowKeyStep: slider.arrowKeyStep,
			tags: slider.tags,
			adsorption: slider.adsorption,
			valueToDisplay: slider.valueToDisplay,
			valueToParam: slider.valueToParam,
		};
	});

	const handleChange = (sName: string, value: any) => {
		// @ts-ignore
		audioParams.value[sName] = value;
		appStore.applyParameters();
		if (sName == 'acodec') {
			appStore.checkAndApplyCodecDefaults({ audio: true });
		}
	};
	const handleDetailChange = (sName: string, value: any) => {
		if (!audioParams.value.detail) audioParams.value.detail = {};
		audioParams.value.detail[sName] = value;
		appStore.applyParameters();
	};

	const handleApplyToAll = () => {
		const params = audioParams.value;
		for (const outputParams of appStore.globalParams.outputs) {
			outputParams.audio = JSON.parse(JSON.stringify(params));
		}
	};

	return () => audioParams.value && audioContainsInOutput.value ? (
		<div class={css.container}>
			<BoxedDropdownInput title="音频编码器" text={audioParams.value.acodec} list={combinedVcodecsList.value} onChange={(value: string) => handleChange('acodec', value)} />
			{['禁用', 'copy'].indexOf(audioParams.value.acodec) === -1 && (
				<>
					{(acodec.value?.rateControl || []).length ? (
						<BoxedDropdownInput title="码率控制" text={audioParams.value.ratecontrol} list={rateControlList.value} onChange={(value: string) => handleChange('ratecontrol', value)} />
					) : null}
					{rateControlSlider.value && (
						<BoxedSlider
							title={rateControlSlider.value.title}
							value={audioParams.value.ratevalue}
							min={rateControlSlider.value.min}
							max={rateControlSlider.value.max}
							arrowKeyStep={rateControlSlider.value.arrowKeyStep}
							tags={rateControlSlider.value.tags}
							valueToDisplay={rateControlSlider.value.valueToDisplay}
							adsorption={rateControlSlider.value.adsorption}
							onChange={(value: number) => handleChange('ratevalue', value)}
						/>
					)}
					{renderDetailParameters(acodec.value?.parameters, audioParams.value.detail, (parameter, value: string) => handleDetailChange(parameter.parameter, value), false)}
					<BoxedSlider
						title="音量"
						description='请注意新版 ffmpeg 不再支持 -vol 参数，请换用滤镜进行音量处理'
						value={audioParams.value.vol}
						min={volSlider.min}
						max={volSlider.max}
						tags={volSlider.tags}
						valueToDisplay={volSlider.valueToDisplay}
						adsorption={volSlider.adsorption}
						onChange={(value: number) => handleChange('vol', value)}
					/>
				</>
			)}
			<BoxedNormalInput title="自定义参数" value={audioParams.value.custom} onChange={(value: string) => handleChange('custom', value)} long={true} />
			{(acodec.value?.parameters || []).filter((parameter) => parameter.optional).length && (
				<AutoSizeWrapper class={css.detailParameters} style={({ height }) => ({ height: showDetailParams.value ? `${height}px` : '42px' })} useResizeObserver={true}>
					<div class={css.bar}>
						<Button type={ButtonType.NoBg} onClick={() => showDetailParams.value = !showDetailParams.value}>点击{showDetailParams.value ? '隐藏' : '显示'}·详细参数</Button>
					</div>
					{renderDetailParameters(acodec.value?.parameters, audioParams.value.detail, (parameter, value: string) => handleDetailChange(parameter.parameter, value), true)}
					<div class={css.bar}>
						<Button type={ButtonType.NoBg} onClick={() => showDetailParams.value = !showDetailParams.value}>点击{showDetailParams.value ? '隐藏' : '显示'}·详细参数</Button>
					</div>
				</AutoSizeWrapper>
			) || null}
			{appStore.globalParams.outputs.length > 1 && (
				<div style={{ margin: '12px' }}>
					<Button onClick={handleApplyToAll}>
						应用音频参数到全部输出
					</Button>
				</div>			
			)}
		</div>
	) : (
		<div class={css.noOutput}>
			<div class={css.box}>
				<ImageFind />
				<div class={css.description}>
					<p>您正在编辑【输出 {props.editingOutputIndex}】的音频配置</p>
					<p>但【输出文件 {props.editingOutputIndex}】节点在滤镜图中不存在或未连接任何输入</p>
					<p>请先在“滤镜”面板中为该节点建立连线</p>
				</div>
			</div>
		</div>
	);
}, {
	props: ['editingOutputIndex'],
});

export default AcodecView;
