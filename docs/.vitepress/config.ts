import { defineConfig } from 'vitepress'

const packages = ['core', 'store-postgres', 'provider-managed-agents', 'provider-agentcore', 'agentcore-runtime', 'protocol', 'conformance']
const examples = ['express-sse', 'agentcore-container']

/**
 * Local docs site: `pnpm docs:dev`. Renders the repository's Markdown in place (docs/*.md and every
 * README), so the files stay the single source of truth and keep working on GitHub.
 */
export default defineConfig({
  title: 'agent-runtime',
  description: 'One session API and one event stream for every agent provider',
  srcDir: '..',
  srcExclude: ['**/node_modules/**', '**/dist/**'],
  rewrites: {
    'README.md': 'index.md',
    'packages/:pkg/README.md': 'packages/:pkg/index.md',
    'examples/:ex/README.md': 'examples/:ex/index.md',
  },
  cleanUrls: true,
  ignoreDeadLinks: 'localhostLinks',
  markdown: {
    config(md) {
      // READMEs are rewritten to directory index pages; point links at the directory.
      md.core.ruler.push('readme-links', (state) => {
        for (const token of state.tokens) {
          for (const child of token.children ?? []) {
            const href = child.type === 'link_open' ? child.attrGet('href') : null
            if (!href || /^[a-z]+:/i.test(href)) continue
            const fixed = href.replace(/(^|\/)README\.md(?=#|$)/, (_m, slash: string) => slash || './')
            if (fixed !== href) child.attrSet('href', fixed)
          }
        }
      })
    },
  },
  themeConfig: {
    search: { provider: 'local' },
    outline: [2, 3],
    nav: [
      { text: 'Guide', link: '/docs/concepts' },
      { text: 'Packages', link: '/packages/core/' },
      { text: 'Examples', link: '/examples/express-sse/' },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Concepts', link: '/docs/concepts' },
          { text: 'Getting started', link: '/docs/getting-started' },
        ],
      },
      {
        text: 'Building an application',
        items: [
          { text: 'Frontend guide', link: '/docs/frontend-guide' },
          { text: 'Event model', link: '/docs/event-model' },
          { text: 'Tools and approvals', link: '/docs/tools-and-approvals' },
        ],
      },
      {
        text: 'Providers',
        items: [
          { text: 'Claude Managed Agents', link: '/docs/managed-agents' },
          { text: 'Bedrock AgentCore', link: '/docs/agentcore' },
        ],
      },
      {
        text: 'Running in production',
        items: [
          { text: 'Scaling and failover', link: '/docs/scaling-and-failover' },
          { text: 'Operations', link: '/docs/operations' },
        ],
      },
      {
        text: 'How it works',
        items: [
          { text: 'Behaviour spec', link: '/docs/behavior-spec' },
          { text: 'Architecture', link: '/docs/architecture' },
          { text: 'Event coverage', link: '/docs/event-coverage' },
          { text: 'Writing a provider or driver', link: '/docs/extending' },
        ],
      },
      { text: 'Packages', collapsed: false, items: packages.map((p) => ({ text: `@agent-runtime/${p}`, link: `/packages/${p}/` })) },
      { text: 'Examples', collapsed: false, items: examples.map((e) => ({ text: e, link: `/examples/${e}/` })) },
    ],
  },
})
