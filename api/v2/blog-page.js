import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return ''; }
}

export default async function handler(req, res) {
  const slug = req.query.slug;
  const type = req.query.type; // 'category', 'tag', 'author', or undefined (post)

  if (!slug) {
    return res.status(400).send('Not found');
  }

  // --- Category, tag, and author pages serve the listing template ---
  if (type === 'category' || type === 'tag' || type === 'author') {
    let html;
    try {
      html = readFileSync(join(process.cwd(), 'blog', 'index.html'), 'utf-8');
    } catch {
      return res.status(500).send('Error loading page');
    }

    let pageTitle = 'Ryvite Blog';
    let pageDescription = 'Event planning tips, inspiration, and product updates from Ryvite.';

    if (type === 'category') {
      // Try to get category name
      const { data: cat } = await supabaseAdmin
        .from('blog_categories')
        .select('name')
        .eq('slug', slug)
        .single();
      const catName = cat?.name || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      pageTitle = `${catName} Articles — Ryvite Blog`;
      pageDescription = `Browse ${catName.toLowerCase()} articles and guides on the Ryvite Blog.`;
    } else if (type === 'tag') {
      const tagName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      pageTitle = `Posts tagged "${tagName}" — Ryvite Blog`;
      pageDescription = `Browse posts tagged "${tagName}" on the Ryvite Blog.`;
    } else if (type === 'author') {
      const authorName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      pageTitle = `${authorName} — Ryvite Blog`;
      pageDescription = `Articles by ${authorName} on the Ryvite Blog.`;
    }

    html = html.replace(
      '<title>Ryvite Blog</title>',
      `<title>${escapeHtml(pageTitle)}</title>`
    );
    html = html.replace(
      '<meta name="description" content="Event planning tips, inspiration, and product updates from Ryvite.">',
      `<meta name="description" content="${escapeHtml(pageDescription)}">`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).send(html);
  }

  // --- Blog post page ---
  // Check for redirects first
  try {
    const { data: redirect } = await supabaseAdmin
      .from('blog_redirects')
      .select('new_slug')
      .eq('old_slug', slug)
      .limit(1)
      .single();

    if (redirect) {
      res.setHeader('Location', `/blog/${redirect.new_slug}`);
      return res.status(301).end();
    }
  } catch (e) {
    // No redirect found, continue
  }

  // Read the post template
  let html;
  try {
    html = readFileSync(join(process.cwd(), 'blog', 'post.html'), 'utf-8');
  } catch {
    return res.status(500).send('Error loading page');
  }

  // Fetch post data for OG tags
  try {
    const { data: post } = await supabaseAdmin
      .from('blog_posts')
      .select('title, excerpt, slug, published_date, modified_date, category, tags, author_slug, featured_image, seo, content')
      .eq('slug', slug)
      .eq('status', 'published')
      .single();

    if (!post) {
      // Return 404
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(404).send(`<!DOCTYPE html><html><head><title>Post Not Found — Ryvite Blog</title>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#FFFAF5;color:#1A1A2E;text-align:center;padding:20px}
.wrap{max-width:500px}h1{font-family:'Playfair Display',serif;font-size:2rem;margin-bottom:12px}p{margin-bottom:24px;color:#666}
a{color:#E94560;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}</style>
</head><body><div class="wrap"><h1>Post Not Found</h1><p>The blog post you're looking for doesn't exist or has been removed.</p><a href="/blog">Back to Blog</a></div></body></html>`);
    }

    const title = escapeHtml(post.seo?.metaTitle || post.title);
    const description = escapeHtml(post.seo?.metaDescription || post.excerpt || '');
    const ogTitle = escapeHtml(post.seo?.ogTitle || post.title);
    const ogDescription = escapeHtml(post.seo?.ogDescription || post.excerpt || '');
    const ogImage = escapeHtml(post.seo?.ogImage || post.featured_image?.src || 'https://www.ryvite.com/og-default.png');
    const ogImageAlt = escapeHtml(post.seo?.ogImageAlt || post.featured_image?.alt || post.title);
    const canonicalUrl = post.seo?.canonicalUrl || `https://www.ryvite.com/blog/${post.slug}`;
    const publishedDate = post.published_date || '';
    const modifiedDate = post.modified_date || '';
    const authorName = (post.author_slug || 'Ryvite Team').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Build OG/meta tags
    const metaTags = `
  <meta name="description" content="${description}">
  <!-- Open Graph -->
  <meta property="og:type" content="article">
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${ogDescription}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:image:alt" content="${ogImageAlt}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:site_name" content="Ryvite">
  <meta property="article:published_time" content="${publishedDate}">
  <meta property="article:modified_time" content="${modifiedDate}">
  <meta property="article:section" content="${escapeHtml(post.category || '')}">
  ${(post.tags || []).map(t => `<meta property="article:tag" content="${escapeHtml(t)}">`).join('\n  ')}
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${ogDescription}">
  <meta name="twitter:image" content="${ogImage}">
  <!-- Canonical -->
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  ${post.seo?.noIndex ? '<meta name="robots" content="noindex, nofollow">' : ''}`;

    // JSON-LD structured data
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.excerpt || '',
      image: post.featured_image?.src || 'https://www.ryvite.com/og-default.png',
      author: { '@type': 'Person', name: authorName },
      datePublished: publishedDate,
      dateModified: modifiedDate,
      publisher: {
        '@type': 'Organization',
        name: 'Ryvite',
        logo: { '@type': 'ImageObject', url: 'https://www.ryvite.com/og-default.png' }
      },
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl }
    };

    const jsonLdScript = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;

    // Breadcrumb JSON-LD
    const breadcrumbLd = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.ryvite.com' },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://www.ryvite.com/blog' },
        { '@type': 'ListItem', position: 3, name: post.category || 'Article', item: `https://www.ryvite.com/blog/category/${post.category || 'general'}` },
        { '@type': 'ListItem', position: 4, name: post.title }
      ]
    };

    const breadcrumbScript = `<script type="application/ld+json">${JSON.stringify(breadcrumbLd)}</script>`;

    // Inject into template
    html = html.replace(
      '<title>Blog Post — Ryvite</title>',
      `<title>${title} — Ryvite</title>`
    );
    html = html.replace(
      '<meta name="description" content="Read this post on the Ryvite Blog.">',
      metaTags
    );
    html = html.replace('</head>', `  ${jsonLdScript}\n  ${breadcrumbScript}\n</head>`);
  } catch (e) {
    console.error('Blog page OG tag fetch failed:', e.message);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).send(html);
}
