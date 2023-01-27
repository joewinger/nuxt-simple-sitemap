import { writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import {
  addServerHandler,
  addTemplate,
  createResolver,
  defineNuxtModule,
  useLogger,
} from '@nuxt/kit'
import { defu } from 'defu'
import type { SitemapStreamOptions } from 'sitemap'
import { SitemapStream, streamToPromise } from 'sitemap'
import { createRouter as createRadixRouter, toRouteMatcher } from 'radix3'
import chalk from 'chalk'
import { withTrailingSlash, withoutTrailingSlash } from 'ufo'
import type { SitemapItemLoose } from 'sitemap/dist/lib/types'
import type { CreateFilterOptions } from './urlFilter'
import { createFilter } from './urlFilter'
import { exposeModuleConfig } from './nuxt-utils'
import { resolvePagesRoutes, uniqueBy } from './page-utils'

export type MaybeFunction<T> = T | (() => T)
export type MaybePromise<T> = T | Promise<T>
export type SitemapEntry = SitemapItemLoose | string

export interface ModuleOptions extends CreateFilterOptions, SitemapStreamOptions {
  /**
   * Whether the sitemap.xml should be generated.
   *
   * @default true
   */
  enabled: boolean
  /**
   * Should the URLs be inserted with a trailing slash.
   *
   * @default false
   */
  trailingSlash: boolean
  /**
   * Default options to pass for each sitemap entry.
   */
  defaults: Partial<SitemapItemLoose>
  /**
   * Defaults URLS to be included in the sitemap.
   */
  urls: MaybeFunction<MaybePromise<SitemapEntry[]>>

  devPreview: boolean

  inferStaticPagesAsRoutes: boolean
}

export interface ModuleHooks {
  'sitemap:generate': (ctx: { urls: SitemapItemLoose[]; sitemap: SitemapStream }) => Promise<void> | void
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-simple-sitemap',
    compatibility: {
      nuxt: '^3.0.0',
      bridge: false,
    },
    configKey: 'sitemap',
  },
  defaults(nuxt) {
    const trailingSlash = nuxt.options.runtimeConfig.public.trailingSlash
    return {
      include: ['/**'],
      hostname: nuxt.options.runtimeConfig.public?.siteUrl,
      // false by default
      trailingSlash: typeof trailingSlash !== 'undefined' ? trailingSlash : false,
      enabled: true,
      urls: [],
      defaults: {},
      devPreview: true,
      inferStaticPagesAsRoutes: true,
    }
  },
  async setup(config, nuxt) {
    const { resolve } = createResolver(import.meta.url)

    const hasI18nModule = nuxt.options.modules.includes('@nuxtjs/i18n')

    // paths.d.ts
    addTemplate({
      filename: 'nuxt-simple-sitemap.d.ts',
      getContents: () => {
        return `// Generated by nuxt-simple-sitemap
import type { SitemapItemLoose } from 'sitemap'

type SitemapEntry = SitemapItemLoose & {
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never' | (string & Record<never, never>)
}

interface NuxtSimpleSitemapNitroRules {
  index?: boolean
  sitemap?: SitemapEntry
}
declare module 'nitropack' {
  interface NitroRouteRules extends NuxtSimpleSitemapNitroRules {}
  interface NitroRouteConfig extends NuxtSimpleSitemapNitroRules {}
}
export {}
`
      },
    })

    nuxt.hooks.hook('prepare:types', ({ references }) => {
      references.push({ path: resolve(nuxt.options.buildDir, 'nuxt-simple-sitemap.d.ts') })
    })

    // don't run with `nuxi prepare`
    if (nuxt.options._prepare)
      return

    // @ts-expect-error untyped
    const fixSlashes = (url: string) => nuxt.options.sitemap?.trailingSlash ? withTrailingSlash(url) : withoutTrailingSlash(url)

    const prerendedRoutes: SitemapItemLoose[] = []
    const urlFilter = createFilter(config)

    async function generateUrls() {
      let urls: SitemapEntry[] = []
      if (!config.inferStaticPagesAsRoutes)
        return urls as SitemapItemLoose[]
      if (typeof config.urls === 'function')
        urls = [...await config.urls()]

      else if (Array.isArray(config.urls))
        urls = [...await config.urls]

      // convert to object format, mix in defaults
      const normalisedUrls = [
        ...urls
          .map(url => typeof url === 'string' ? { url } : url)
          .map(url => ({ ...config.defaults, ...url })),
      ]
      // @todo this is hacky, have nuxt expose this earlier
      const pages = await resolvePagesRoutes()
      pages.forEach((page) => {
        // only include static pages
        if (!page.path.includes(':') && urlFilter(page.path)) {
          normalisedUrls.push({
            url: fixSlashes(page.path),
          })
        }
      })
      // make sure each urls entry has a unique url
      return uniqueBy(normalisedUrls, 'url')
        // shorter urls should be first
        .sort((a, b) => a.url.length - b.url.length)
    }

    // not needed if preview is disabled
    if (nuxt.options.dev) {
      let urls: any[] = ['/']
      if (config.devPreview) {
        urls = await generateUrls()
        // give a warning when accessing sitemap in dev mode
        addServerHandler({
          route: '/sitemap.xml',
          handler: resolve('./runtime/sitemap.xml'),
        })
        addServerHandler({
          route: '/sitemap.preview.xml',
          handler: resolve('./runtime/sitemap.preview.xml'),
        })
      }
      exposeModuleConfig('nuxt-simple-sitemap', {
        ...config,
        urls,
      })
      return
    }

    const urls = await generateUrls()

    nuxt.hooks.hook('nitro:init', async (nitro) => {
      // tell the user if the sitemap isn't being generated
      const logger = useLogger('nuxt-simple-sitemap')
      if (!config.hostname) {
        logger.warn('Please set a `hostname` on the `sitemap` config to use `nuxt-simple-sitemap`.')
        return
      }
      if (!config.enabled) {
        logger.warn('Sitemap generation is disabled. Set `sitemap.enabled` to `true` to enable it.')
        return
      }

      let sitemapGenerate = false
      const outputSitemap = async () => {
        if (sitemapGenerate)
          return
        const start = Date.now()
        const _routeRulesMatcher = toRouteMatcher(
          createRadixRouter({ routes: nitro.options.routeRules }),
        )
        const stream = new SitemapStream(config)

        // shorter urls should be first
        const sitemapUrls = uniqueBy(
          ([...urls, ...prerendedRoutes])
            // filter for config
            .filter(entry => urlFilter(entry.url))
            .sort((a, b) => a.url.length - b.url.length)
            // check route rules
            .map((entry) => {
              const url = entry.url
              // route matcher assumes all routes have no trailing slash
              const routeRules = defu({}, ..._routeRulesMatcher.matchAll(withoutTrailingSlash(url)).reverse())
              // @ts-expect-error untyped
              if (routeRules.index === false)
                return false

              // @ts-expect-error untyped
              return { ...entry, url: fixSlashes(url), ...config.defaults, ...(routeRules.sitemap || {}) }
            })
            .filter(Boolean),
          'url',
        )

        const sitemapContext = { stream, urls: sitemapUrls }
        // @ts-expect-error untyped
        await nuxt.hooks.callHook('sitemap:generate', sitemapContext)
        if (sitemapContext.urls.length === 0)
          return
        // Return a promise that resolves with your XML string
        const sitemapXml = await streamToPromise(Readable.from(sitemapContext.urls).pipe(sitemapContext.stream))
          .then(data => data.toString())

        await writeFile(resolve(nitro.options.output.publicDir, 'sitemap.xml'), sitemapXml)
        const generateTimeMS = Date.now() - start
        nitro.logger.log(chalk.gray(
          `  └─ /sitemap.xml (${generateTimeMS}ms)`,
        ))
        sitemapGenerate = true
      }

      nitro.hooks.hook('prerender:route', async ({ route }) => {
        // check if the route path is not for a file
        if (!route.includes('.')) {
          // ensure we add routes with consistent slashes
          prerendedRoutes.push({ url: route })
        }
      })

      // SSR mode
      nitro.hooks.hook('rollup:before', async () => {
        await outputSitemap()
      })

      // SSG mode
      nitro.hooks.hook('close', async () => {
        await outputSitemap()
      })
    })
  },
})
