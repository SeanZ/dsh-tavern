// 上游接线边界：业务实现由 Tavern 持有，故事层只负责投影、受控操作与渲染契约。
// @include-story story-rounds.js
// @include-story-client transcript.js
// @include-story-client service.js
// @include-story-client render.js

const storyTranscript = createStoryTranscriptAdapter({ createTavernStoryTranscriptDataModule, tavernProjectionForTurn });

const { createTavernStoryService, tavernStoryTurnArgument, tavernStorySessionArgument } = createStoryServiceAdapter({
	window,
	storyTranscript,
	rpc,
	liveTavernView,
	notifyTavernDataChanged,
	tavernCoordination,
	isPlayMode,
	tavernStorySessionState,
	readTavernStorySessionMode,
	subscribeTavernStorySessionMode,
	tavernStoryViewMode,
	tavernStoryViewActive,
	tavernMvuReceiptForTurn,
	tavernConversationForkRequests,
	tavernErrorHub,
	createStoryRoundsFold,
	foldStoryRounds,
	filterStoryRounds,
});

const { createTavernStoryRender } = createStoryRenderAdapter({
	window,
	storyTranscript,
	React,
	BODY_RENDER_VERSION,
	TavernAutomaticStatusRuntime,
	createBodyRenderPlan,
	prepareTavernBodyGroup,
	TavernBodyGroup,
	TavernBodyMarkdown,
	sanitizeTavernBodyHtml,
	liveTavernView,
	projectionPartsOf,
	tavernLatestProjectionTurn,
	useLiveTavernView,
	useTavernUiExtensions,
	useTavernCardPluginScopes,
	isPlayMode,
	useTavernPluginMedia,
	createTavernPluginTextContext,
	tavernRetainedFrames,
	tavernCodeLabels,
	tavernMarkdownLabels,
	renderTavernProjection,
	TavernPluginMediaItem,
	TavernIllustrationDraft,
	tavernUiExtensions,
	tavernPluginAllowed,
	assistantRendererFeature,
	captureTavernBoundedDom,
	installTavernTextColors,
	findTavernQuoteRanges,
	bindTavernFontZoom,
	tavernStorySessionArgument,
});

function registerTavernStoryContract(ctx) {
	ctx.provide("tavernStory", createTavernStoryService({
		sessions: ctx.sessions,
		actions: playControlsFeature.storyActions,
		render: createTavernStoryRender({ executeSlash: createTavernFrameSlashExecutor(ctx) })
	}));
}
