import showdown from 'showdown'
import markdown from './body-markdown.cjs'
import plan from './body-render-plan.cjs'

import version from './body-version.cjs'
export const BODY_RENDER_VERSION = version.BODY_RENDER_VERSION
export const renderBodyMarkdown = markdown.createTavernBodyMarkdown(showdown)
export const createBodyRenderPlan = plan.createBodyRenderPlan
