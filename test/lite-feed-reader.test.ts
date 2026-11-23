import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BrowserManager,
  type ElementDescriptor,
  buildFeedReaderDocument,
  detectFeedKind,
  discoverFeedsInHtml,
  formatByteSize,
  formatFeedDate,
  htmlFragmentToPlainText,
  parseFeedXml,
  parseHtmlDocument,
  renderFeedAscii,
} from '../src/index.js'

const SAMPLE_RSS_2 = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/feed.xsl"?>
<!-- Troy test RSS feed -->
<rss version="2.0"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Troy Engineering Blog &amp; Notes</title>
    <link>https://blog.example.test/</link>
    <description>Terminal-native AI browser engineering updates</description>
    <language>en-us</language>
    <lastBuildDate>Mon, 23 Nov 2026 12:00:00 GMT</lastBuildDate>
    <item>
      <title><![CDATA[Release v2.0 — ASCII &amp; Feed Reader]]></title>
      <link>/posts/v2-release</link>
      <guid isPermaLink="false">post-v2-release</guid>
      <pubDate>Mon, 23 Nov 2026 10:30:00 GMT</pubDate>
      <dc:creator>Anish</dc:creator>
      <category>release</category>
      <category>ascii</category>
      <description><![CDATA[<p>Short intro with <b>bold</b> &amp; entities.</p>]]></description>
      <content:encoded><![CDATA[
        <p>Short intro with <b>bold</b> &amp; entities.</p>
        <p>Full article body explains zero-Chrome RSS &amp; Atom rendering on EC2.</p>
        <ul><li>Fast</li><li>Strict 7-bit ASCII</li></ul>
      ]]></content:encoded>
      <enclosure url="/media/episode-42.mp3" type="audio/mpeg" length="5242880" />
      <comments>/posts/v2-release#comments</comments>
    </item>
    <item>
      <title>Deep Dive: CookieJar Persistence</title>
      <guid isPermaLink="true">https://blog.example.test/posts/cookiejar</guid>
      <pubDate>Sun, 22 Nov 2026 08:15:00 GMT</pubDate>
      <author>dev@example.test</author>
      <category>engineering</category>
      <description>&lt;p&gt;How 0600 cookies.json works across restarts.&lt;/p&gt;</description>
    </item>
    <item>
      <title>Security Hardening Checklist</title>
      <link>javascript:alert(1)</link>
      <pubDate>Sat, 21 Nov 2026 06:00:00 GMT</pubDate>
      <category>release</category>
      <description>Unsafe link schemes must be stripped cleanly.</description>
    </item>
  </channel>
</rss>`

const SAMPLE_RSS_1_RDF = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.test/">
    <title>RDF 1.0 Feed</title>
    <link>https://rdf.example.test/</link>
    <description>Classic RSS 1.0 channel</description>
  </channel>
  <item rdf:about="https://rdf.example.test/item/1">
    <title>First RDF Story</title>
    <link>https://rdf.example.test/item/1</link>
    <description>RDF item summary text.</description>
    <dc:creator>Ada</dc:creator>
    <dc:date>2026-11-20T09:00:00Z</dc:date>
  </item>
</rdf:RDF>`

const SAMPLE_ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://atom.example.test/">
  <title>Troy Atom Changelog</title>
  <subtitle>Daily autonomous milestones</subtitle>
  <updated>2026-11-23T14:00:00Z</updated>
  <id>urn:uuid:troy-atom-feed</id>
  <author><name>Troy Bot</name></author>
  <link rel="self" href="/atom.xml" />
  <link rel="alternate" href="/changelog" />
  <entry>
    <title>M38: Feed Reader Shipped</title>
    <id>urn:uuid:entry-m38</id>
    <published>2026-11-23T13:00:00Z</published>
    <updated>2026-11-23T13:30:00Z</updated>
    <link rel="self" href="/entries/m38.xml" />
    <link rel="alternate" href="/posts/m38" />
    <link rel="enclosure" href="/assets/demo.png" type="image/png" length="102400" />
    <category term="feeds" label="Feeds" />
    <summary type="text">RSS and Atom auto-detection now live.</summary>
    <content type="xhtml">
      <div xmlns="http://www.w3.org/1999/xhtml">
        <p>Full XHTML content for M38 feed reader.</p>
      </div>
    </content>
  </entry>
  <entry>
    <title>M37: Structured Views</title>
    <id>urn:uuid:entry-m37</id>
    <updated>2026-11-22T11:00:00Z</updated>
    <link href="/posts/m37" />
    <category term="xml" />
    <summary type="html">&lt;p&gt;Collapsible JSON &amp;amp; XML views.&lt;/p&gt;</summary>
  </entry>
</feed>`

describe('M38: RSS / Atom feed auto-detection and structured ASCII feed reader', () => {
  describe('detectFeedKind', () => {
    it('detects RSS and Atom by explicit MIME types', () => {
      expect(detectFeedKind('application/rss+xml; charset=utf-8', '<rss/>')).toBe('rss')
      expect(detectFeedKind('text/rss+xml', '<rss/>')).toBe('rss')
      expect(detectFeedKind('application/atom+xml', '<feed/>')).toBe('atom')
    })

    it('sniffs RSS 2.0, RSS 1.0 RDF, and Atom 1.0 served with generic XML MIME types', () => {
      expect(detectFeedKind('application/xml', SAMPLE_RSS_2)).toBe('rss')
      expect(detectFeedKind('text/xml; charset=utf-8', `\uFEFF${SAMPLE_ATOM}`)).toBe('atom')
      expect(detectFeedKind('application/rdf+xml', SAMPLE_RSS_1_RDF)).toBe('rss')
      expect(detectFeedKind('', SAMPLE_RSS_2)).toBe('rss')
      expect(detectFeedKind('text/plain', SAMPLE_ATOM, 'https://example.test/feed.atom')).toBe('atom')
    })

    it('returns null for non-feed XML, HTML, and JSON documents', () => {
      expect(detectFeedKind('application/xml', '<?xml version="1.0"?><catalog><book id="1"/></catalog>')).toBeNull()
      expect(detectFeedKind('text/html', '<html><body><rss/></body></html>')).toBeNull()
      expect(detectFeedKind('application/xhtml+xml', '<html><body>Hi</body></html>')).toBeNull()
      expect(detectFeedKind('application/json', '{"feed": true}')).toBeNull()
    })
  })

  describe('discoverFeedsInHtml', () => {
    it('discovers RSS and Atom <link rel="alternate"> tags, resolves relative URLs, and rejects unsafe schemes', () => {
      const html = `<!doctype html>
      <html>
        <head>
          <title>My Blog</title>
          <link rel="stylesheet" href="/app.css" />
          <link rel="alternate" type="application/rss+xml" title="Main RSS" href="/rss.xml" />
          <link rel="alternate noopener" type="application/atom+xml; charset=utf-8" title="Atom Updates" href="feeds/atom.xml" />
          <link rel="alternate" type="application/rss+xml" title="Duplicate RSS" href="/rss.xml" />
          <link rel="alternate" type="application/rss+xml" title="Unsafe" href="javascript:alert(1)" />
          <!-- <link rel="alternate" type="application/rss+xml" href="/commented.xml" /> -->
        </head>
        <body><h1>Hello</h1></body>
      </html>`

      const feeds = discoverFeedsInHtml(html, 'https://site.example.test/blog/index.html')
      expect(feeds).toEqual([
        {
          url: 'https://site.example.test/rss.xml',
          kind: 'rss',
          title: 'Main RSS',
          mimeType: 'application/rss+xml',
        },
        {
          url: 'https://site.example.test/blog/feeds/atom.xml',
          kind: 'atom',
          title: 'Atom Updates',
          mimeType: 'application/atom+xml',
        },
      ])
    })

    it('surfaces discovered feeds in parseHtmlDocument with clickable links', () => {
      const html = `<html><head>
        <base href="https://cdn.example.test/news/" />
        <link rel="alternate" type="application/atom+xml" title="News Atom" href="atom.xml" />
      </head><body><h1>News</h1><p>Welcome.</p></body></html>`

      const parsed = parseHtmlDocument(html, 'https://origin.example.test/')
      expect(parsed.feeds).toHaveLength(1)
      expect(parsed.feeds?.[0]?.url).toBe('https://cdn.example.test/news/atom.xml')
      const feedEl = parsed.elements.find((e) => e.selector === 'feed-autodiscover:0')
      expect(feedEl).toBeDefined()
      expect(feedEl?.href).toBe('https://cdn.example.test/news/atom.xml')
      expect(parsed.text).toContain('Feeds: [Atom] News Atom')
    })
  })

  describe('parseFeedXml & helpers', () => {
    it('parses RSS 2.0 with CDATA, content:encoded, dc:creator, categories, enclosures, guid permalink, and unsafe URL filtering', () => {
      const feed = parseFeedXml(SAMPLE_RSS_2, 'https://blog.example.test/rss.xml', 'rss')
      expect(feed.kind).toBe('rss')
      expect(feed.version).toBe('2.0')
      expect(feed.title).toBe('Troy Engineering Blog & Notes')
      expect(feed.siteUrl).toBe('https://blog.example.test/')
      expect(feed.language).toBe('en-us')
      expect(feed.dateDisplay).toBe('2026-11-23 12:00 UTC')
      expect(feed.items).toHaveLength(3)

      const first = feed.items[0]!
      expect(first.title).toContain('Release v2.0')
      expect(first.link).toBe('https://blog.example.test/posts/v2-release')
      expect(first.author).toBe('Anish')
      expect(first.categories).toEqual(['release', 'ascii'])
      expect(first.summary).toBe('Short intro with bold & entities.')
      expect(first.content).toContain('Full article body explains zero-Chrome RSS & Atom rendering on EC2.')
      expect(first.content).toContain('- Fast')
      expect(first.enclosures).toEqual([
        { url: 'https://blog.example.test/media/episode-42.mp3', type: 'audio/mpeg', length: 5242880 },
      ])
      expect(first.commentsUrl).toBe('https://blog.example.test/posts/v2-release#comments')

      const second = feed.items[1]!
      expect(second.link).toBe('https://blog.example.test/posts/cookiejar')
      expect(second.summary).toBe('How 0600 cookies.json works across restarts.')

      const third = feed.items[2]!
      expect(third.link).toBeUndefined()
    })

    it('parses RSS 1.0 (RDF) feeds', () => {
      const feed = parseFeedXml(SAMPLE_RSS_1_RDF, 'https://rdf.example.test/rss.rdf')
      expect(feed.kind).toBe('rss')
      expect(feed.version).toBe('1.0')
      expect(feed.title).toBe('RDF 1.0 Feed')
      expect(feed.items).toHaveLength(1)
      expect(feed.items[0]?.title).toBe('First RDF Story')
      expect(feed.items[0]?.author).toBe('Ada')
      expect(feed.items[0]?.dateDisplay).toBe('2026-11-20 09:00 UTC')
    })

    it('parses Atom 1.0 feeds with xml:base, alternate/enclosure links, XHTML content, and inherited author', () => {
      const feed = parseFeedXml(SAMPLE_ATOM, 'https://atom.example.test/atom.xml')
      expect(feed.kind).toBe('atom')
      expect(feed.title).toBe('Troy Atom Changelog')
      expect(feed.subtitle).toBe('Daily autonomous milestones')
      expect(feed.siteUrl).toBe('https://atom.example.test/changelog')
      expect(feed.author).toBe('Troy Bot')
      expect(feed.items).toHaveLength(2)

      const first = feed.items[0]!
      expect(first.link).toBe('https://atom.example.test/posts/m38')
      expect(first.author).toBe('Troy Bot')
      expect(first.categories).toEqual(['Feeds'])
      expect(first.summary).toBe('RSS and Atom auto-detection now live.')
      expect(first.content).toContain('Full XHTML content for M38 feed reader.')
      expect(first.enclosures).toEqual([
        { url: 'https://atom.example.test/assets/demo.png', type: 'image/png', length: 102400 },
      ])

      const second = feed.items[1]!
      expect(second.link).toBe('https://atom.example.test/posts/m37')
      expect(second.summary).toBe('Collapsible JSON & XML views.')
    })

    it('handles malformed XML gracefully without throwing', () => {
      const feed = parseFeedXml('not xml at all', 'https://broken.example.test/feed.xml', 'rss')
      expect(feed.items).toEqual([])
      expect(feed.parseError).toBeTruthy()
      const rendered = buildFeedReaderDocument(feed)
      expect(rendered.text).toContain('Parse warning:')
    })

    it('formats dates, byte sizes, and HTML fragments cleanly', () => {
      expect(formatFeedDate('2026-11-23')).toBe('2026-11-23')
      expect(formatFeedDate('not-a-date')).toBe('not-a-date')
      expect(formatByteSize(512)).toBe('512 B')
      expect(formatByteSize(2048)).toBe('2.0 KB')
      expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB')
      expect(htmlFragmentToPlainText('<p>Hello<br/>World</p><script>bad()</script>')).toBe('Hello\nWorld')
    })
  })

  describe('renderFeedAscii & pagination', () => {
    it('renders strict 7-bit ASCII feed reader output and supports pagination', () => {
      const feed = parseFeedXml(SAMPLE_RSS_2, 'https://blog.example.test/rss.xml')
      const ascii = renderFeedAscii(feed, { width: 96, height: 80, expandedItems: new Set([0]) })
      expect(ascii).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/)
      expect(ascii).toContain('[RSS 2.0 FEED] TROY ENGINEERING BLOG & NOTES')
      expect(ascii).toContain('[-] 1. Release v2.0')
      expect(ascii).toContain('Enclosure (audio/mpeg, 5.0 MB)')
      expect(ascii).toContain('[+] 2. Deep Dive: CookieJar Persistence')

      // Pagination over 30 generated items
      const manyItems = Array.from({ length: 30 }, (_, idx) => ({
        id: `id-${idx}`,
        index: idx,
        title: `Entry ${idx + 1}`,
        categories: ['news'],
        summary: `Summary for entry ${idx + 1}`,
        enclosures: [],
      }))
      const paged = buildFeedReaderDocument(
        { kind: 'atom', title: 'Big Feed', feedUrl: 'https://big.example.test/atom.xml', items: manyItems },
        { page: 1, pageSize: 10 },
      )
      expect(paged.totalPages).toBe(3)
      expect(paged.page).toBe(1)
      expect(paged.text).toContain('Page 2 of 3 (showing 11-20 of 30 items)')
      expect(paged.text).toContain('11. Entry 11')
      expect(paged.text).not.toContain('1. Entry 1\n')
    })
  })

  describe('Interactive LiteTab + BrowserManager E2E', () => {
    let server: http.Server
    let baseUrl: string

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<!doctype html><html><head>
            <title>Engineering Home</title>
            <link rel="alternate" type="application/rss+xml" title="Blog RSS" href="/rss.xml" />
            <link rel="alternate" type="application/atom+xml" title="Changelog Atom" href="/atom.xml" />
          </head><body><h1>Engineering Home</h1><p>Read our feeds below.</p></body></html>`)
          return
        }
        if (pathname === '/rss.xml') {
          res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
          res.end(SAMPLE_RSS_2.replace(/https:\/\/blog\.example\.test/g, baseUrl))
          return
        }
        if (pathname === '/atom.xml') {
          // Served with generic application/xml to verify XML root sniffing!
          res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
          res.end(SAMPLE_ATOM.replace(/https:\/\/atom\.example\.test/g, baseUrl))
          return
        }
        if (pathname === '/posts/v2-release') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><title>v2.0 Release Article</title></head><body><h1>v2.0 Release Article</h1><p>Welcome to the full HTML post.</p></body></html>')
          return
        }
        if (pathname === '/catalog.xml') {
          res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
          res.end('<?xml version="1.0"?><catalog><book id="1"><title>Regular XML</title></book></catalog>')
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address() as { port: number }
      baseUrl = `http://127.0.0.1:${addr.port}`
    })

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('auto-discovers feeds on HTML pages, renders RSS/Atom readers, toggles items, filters categories, opens articles, and switches to raw XML', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-feed-reader-'))
      const manager = await BrowserManager.create({ engine: 'lite', profileDir: tmpDir })

      type ReadResult = {
        ok: boolean
        url: string
        title: string
        ascii: string
        elements: ElementDescriptor[]
      }

      try {
        const tab = await manager.openTab(`${baseUrl}/`, true)
        const tabId = tab.id
        const readAscii = async () =>
          (await manager.runTool(tabId, 'page_read_ascii', { width: 100, height: 80 })) as ReadResult

        const homeRead = await readAscii()
        expect(homeRead.ascii).toContain('[RSS] Blog RSS')
        expect(homeRead.ascii).toContain('[Atom] Changelog Atom')

        // Click the auto-discovered RSS feed link
        const rssLinkRef = homeRead.elements.find((e) => e.text.includes('[RSS] Blog RSS'))?.ref
        expect(rssLinkRef).toBeTruthy()
        await manager.runTool(tabId, 'page_click', { ref: rssLinkRef })

        const rssRead = await readAscii()
        expect(rssRead.url).toBe(`${baseUrl}/rss.xml`)
        expect(rssRead.ascii).toContain('[RSS 2.0 FEED] TROY ENGINEERING BLOG & NOTES')
        expect(rssRead.ascii).toContain('[+] 1. Release v2.0')
        expect(rssRead.ascii).not.toContain('Full article body explains zero-Chrome')

        // Expand item 1
        const toggle1Ref = rssRead.elements.find((e) => e.text.includes('[+] 1. Release v2.0'))?.ref
        expect(toggle1Ref).toBeTruthy()
        await manager.runTool(tabId, 'page_click', { ref: toggle1Ref })

        const expandedRead = await readAscii()
        expect(expandedRead.ascii).toContain('[-] 1. Release v2.0')
        expect(expandedRead.ascii).toContain('Full article body explains zero-Chrome RSS & Atom rendering on EC2.')
        expect(expandedRead.ascii).toContain('Enclosure (audio/mpeg, 5.0 MB)')

        // Collapse All -> collapses item 1
        const collapseAllRef = expandedRead.elements.find((e) => e.text === 'Collapse All')?.ref
        expect(collapseAllRef).toBeTruthy()
        await manager.runTool(tabId, 'page_click', { ref: collapseAllRef })
        const collapsedRead = await readAscii()
        expect(collapsedRead.ascii).toContain('[+] 1. Release v2.0')
        expect(collapsedRead.ascii).not.toContain('Full article body explains zero-Chrome')

        // Expand All -> expands all items
        const expandAllRef = collapsedRead.elements.find((e) => e.text === 'Expand All')?.ref
        expect(expandAllRef).toBeTruthy()
        await manager.runTool(tabId, 'page_click', { ref: expandAllRef })
        const allExpandedRead = await readAscii()
        expect(allExpandedRead.ascii).toContain('[-] 1. Release v2.0')
        expect(allExpandedRead.ascii).toContain('[-] 2. Deep Dive: CookieJar Persistence')

        // Filter by #release category (2 of 3 items)
        const releaseFilterRef = allExpandedRead.elements.find((e) => e.text.startsWith('#release ('))?.ref
        expect(releaseFilterRef).toBeTruthy()
        await manager.runTool(tabId, 'page_click', { ref: releaseFilterRef })

        const filteredRead = await readAscii()
        expect(filteredRead.ascii).toContain('Items: 2 of 3 (filter: #release)')
        expect(filteredRead.ascii).not.toContain('Deep Dive: CookieJar Persistence')

        // Clear filter via All button
        const allFilterRef = filteredRead.elements.find((e) => e.text.startsWith('Filter: All ('))?.ref
        expect(allFilterRef).toBeTruthy()
        await manager.runTool(tabId, 'page_click', { ref: allFilterRef })

        const restoredRead = await readAscii()
        expect(restoredRead.ascii).toContain('Deep Dive: CookieJar Persistence')

        // Click "Open: Release v2.0..." link to navigate directly to the HTML article
        const articleLinkRef = restoredRead.elements.find((e) => e.href === `${baseUrl}/posts/v2-release`)?.ref
        expect(articleLinkRef).toBeTruthy()
        await manager.runTool(tabId, 'page_click', { ref: articleLinkRef })

        const articleRead = await readAscii()
        expect(articleRead.url).toBe(`${baseUrl}/posts/v2-release`)
        expect(articleRead.ascii).toContain('Welcome to the full HTML post.')

        // Navigate to Atom feed served as application/xml -> auto-detected as Atom feed!
        await manager.runTool(tabId, 'page_navigate', { url: `${baseUrl}/atom.xml` })
        const atomRead = await readAscii()
        expect(atomRead.ascii).toContain('[ATOM FEED] TROY ATOM CHANGELOG')
        expect(atomRead.ascii).toContain('M38: Feed Reader Shipped')

        // Click "View Raw XML" to switch seamlessly to M37 XML tree view
        const rawXmlRef = atomRead.elements.find((e) => e.text === 'View Raw XML')?.ref
        expect(rawXmlRef).toBeTruthy()
        await manager.runTool(tabId, 'page_click', { ref: rawXmlRef })

        const rawXmlRead = await readAscii()
        expect(rawXmlRead.ascii).toContain('XML:')
        expect(rawXmlRead.ascii).toContain('<feed')

        // Regular non-feed XML still uses M37 XML view directly
        await manager.runTool(tabId, 'page_navigate', { url: `${baseUrl}/catalog.xml` })
        const catalogRead = await readAscii()
        expect(catalogRead.ascii).toContain('XML:')
        expect(catalogRead.ascii).toContain('Regular XML')
      } finally {
        await manager.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })
})
