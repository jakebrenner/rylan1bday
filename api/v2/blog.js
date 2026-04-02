import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FOUNDER_EMAIL = 'jake@getmrkt.com';

async function verifyAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return { error: 'no_token' };

  const token = authHeader.slice(7);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { error: 'invalid_token' };

  const email = user.email.toLowerCase();
  if (email === FOUNDER_EMAIL) return { user };

  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_emails')
    .single();

  if (data?.value) {
    const adminList = data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (adminList.includes(email)) return { user };
  }

  return { error: 'not_admin' };
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function calcReadingTime(content) {
  if (!content) return 1;
  const text = content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').length;
  return Math.max(1, Math.ceil(words / 225));
}

function escapeXml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================
// PUBLIC ACTIONS (no auth required)
// ============================================================

async function handlePublicAction(action, req, res) {
  // --- LIST PUBLISHED ---
  if (action === 'listPublished') {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 12));
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const category = req.query.category || '';
    const tag = req.query.tag || '';
    const author = req.query.author || '';

    let query = supabaseAdmin
      .from('blog_posts')
      .select('id, slug, title, excerpt, published_date, modified_date, category, tags, post_type, author_slug, featured_image, featured, status', { count: 'exact' })
      .eq('status', 'published')
      .order('published_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`title.ilike.%${search}%,excerpt.ilike.%${search}%`);
    }
    if (category) {
      query = query.eq('category', category);
    }
    if (tag) {
      query = query.contains('tags', [tag]);
    }
    if (author) {
      query = query.eq('author_slug', author);
    }

    const { data, error, count } = await query;
    if (error) return res.status(400).json({ error: error.message });

    const posts = (data || []).map(p => ({
      ...p,
      readingTime: calcReadingTime(p.content || p.excerpt || '')
    }));

    return res.status(200).json({
      success: true,
      posts,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  }

  // --- GET BY SLUG ---
  if (action === 'getBySlug') {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'Missing slug' });

    // Check for preview mode
    const preview = req.query.preview === 'true';

    let query = supabaseAdmin
      .from('blog_posts')
      .select('*')
      .eq('slug', slug);

    if (!preview) {
      query = query.eq('status', 'published');
    }

    const { data: post, error } = await query.single();
    if (error || !post) {
      // Check redirects
      const { data: redirect } = await supabaseAdmin
        .from('blog_redirects')
        .select('new_slug')
        .eq('old_slug', slug)
        .limit(1)
        .single();

      if (redirect) {
        return res.status(200).json({ success: true, redirect: redirect.new_slug });
      }
      return res.status(404).json({ error: 'Post not found' });
    }

    post.readingTime = calcReadingTime(post.content);

    // Fetch related posts
    let relatedPosts = [];
    if (post.related_slugs && post.related_slugs.length > 0) {
      const { data: related } = await supabaseAdmin
        .from('blog_posts')
        .select('id, slug, title, excerpt, published_date, category, tags, author_slug, featured_image')
        .in('slug', post.related_slugs)
        .eq('status', 'published');
      relatedPosts = related || [];
    } else {
      // Score-based related posts
      const { data: candidates } = await supabaseAdmin
        .from('blog_posts')
        .select('id, slug, title, excerpt, published_date, category, tags, author_slug, featured_image')
        .eq('status', 'published')
        .neq('id', post.id)
        .limit(20);

      if (candidates) {
        const scored = candidates.map(c => {
          let score = 0;
          if (c.category === post.category) score += 10;
          if (c.tags && post.tags) {
            c.tags.forEach(t => {
              if (post.tags.includes(t)) score += 3;
            });
          }
          return { ...c, _score: score };
        });
        scored.sort((a, b) => b._score - a._score);
        relatedPosts = scored.slice(0, 3).map(({ _score, ...rest }) => rest);
      }
    }

    // Fetch prev/next posts
    const { data: prevPost } = await supabaseAdmin
      .from('blog_posts')
      .select('slug, title')
      .eq('status', 'published')
      .lt('published_date', post.published_date)
      .order('published_date', { ascending: false })
      .limit(1)
      .single();

    const { data: nextPost } = await supabaseAdmin
      .from('blog_posts')
      .select('slug, title')
      .eq('status', 'published')
      .gt('published_date', post.published_date)
      .order('published_date', { ascending: true })
      .limit(1)
      .single();

    return res.status(200).json({
      success: true,
      post,
      relatedPosts,
      prevPost: prevPost || null,
      nextPost: nextPost || null
    });
  }

  // --- GET REDIRECT ---
  if (action === 'getRedirect') {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'Missing slug' });

    const { data: redirect } = await supabaseAdmin
      .from('blog_redirects')
      .select('new_slug')
      .eq('old_slug', slug)
      .limit(1)
      .single();

    if (redirect) {
      return res.status(200).json({ success: true, redirect: redirect.new_slug });
    }
    return res.status(404).json({ error: 'No redirect found' });
  }

  // --- GET FEATURED ---
  if (action === 'getFeatured') {
    const { data, error } = await supabaseAdmin
      .from('blog_posts')
      .select('id, slug, title, excerpt, published_date, category, tags, author_slug, featured_image')
      .eq('status', 'published')
      .eq('featured', true)
      .order('published_date', { ascending: false })
      .limit(5);

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true, posts: data || [] });
  }

  // --- GET ALL TAGS ---
  if (action === 'getAllTags') {
    const { data, error } = await supabaseAdmin
      .from('blog_posts')
      .select('tags')
      .eq('status', 'published');

    if (error) return res.status(400).json({ error: error.message });

    const tagCounts = {};
    (data || []).forEach(p => {
      (p.tags || []).forEach(t => {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      });
    });

    const tags = Object.entries(tagCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return res.status(200).json({ success: true, tags });
  }

  // --- GET ALL CATEGORIES (public) ---
  if (action === 'getAllCategories') {
    const { data: categories, error } = await supabaseAdmin
      .from('blog_categories')
      .select('*')
      .order('name');

    if (error) return res.status(400).json({ error: error.message });

    // Get published post counts per category
    const { data: posts } = await supabaseAdmin
      .from('blog_posts')
      .select('category')
      .eq('status', 'published');

    const counts = {};
    (posts || []).forEach(p => {
      counts[p.category] = (counts[p.category] || 0) + 1;
    });

    const result = (categories || []).map(c => ({
      ...c,
      postCount: counts[c.slug] || 0
    }));

    return res.status(200).json({ success: true, categories: result });
  }

  // --- RSS FEED ---
  if (action === 'rss') {
    const { data: posts } = await supabaseAdmin
      .from('blog_posts')
      .select('title, slug, excerpt, published_date, category, author_slug')
      .eq('status', 'published')
      .order('published_date', { ascending: false })
      .limit(50);

    const baseUrl = 'https://www.ryvite.com';
    const items = (posts || []).map(p => `
    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${baseUrl}/blog/${escapeXml(p.slug)}</link>
      <description>${escapeXml(p.excerpt || '')}</description>
      <pubDate>${new Date(p.published_date).toUTCString()}</pubDate>
      <category>${escapeXml(p.category || '')}</category>
      <author>${escapeXml(p.author_slug || 'Ryvite Team')}</author>
      <guid isPermaLink="true">${baseUrl}/blog/${escapeXml(p.slug)}</guid>
    </item>`).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ryvite Blog</title>
    <link>${baseUrl}/blog</link>
    <description>Event planning tips, inspiration, and product updates from Ryvite.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${baseUrl}/blog/feed.xml" rel="self" type="application/rss+xml" />${items}
  </channel>
</rss>`;

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200');
    return res.status(200).send(xml);
  }

  return null; // Not a public action
}

// ============================================================
// ADMIN ACTIONS (auth required)
// ============================================================

async function handleAdminAction(action, req, res, admin) {

  // --- LIST POSTS (admin) ---
  if (action === 'listPosts') {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const status = req.query.status || '';
    const category = req.query.category || '';

    let query = supabaseAdmin
      .from('blog_posts')
      .select('id, slug, title, excerpt, status, category, tags, post_type, author_slug, featured, featured_image, published_date, modified_date, created_at', { count: 'exact' })
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`title.ilike.%${search}%,excerpt.ilike.%${search}%`);
    }
    if (status) {
      query = query.eq('status', status);
    }
    if (category) {
      query = query.eq('category', category);
    }

    const { data, error, count } = await query;
    if (error) return res.status(400).json({ error: error.message });

    return res.status(200).json({
      success: true,
      posts: data || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  }

  // --- GET POST ---
  if (action === 'getPost') {
    const postId = req.query.postId;
    if (!postId) return res.status(400).json({ error: 'Missing postId' });

    const { data: post, error } = await supabaseAdmin
      .from('blog_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (error || !post) return res.status(404).json({ error: 'Post not found' });
    return res.status(200).json({ success: true, post });
  }

  // --- CREATE POST ---
  if (action === 'createPost') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const body = req.body || {};
    const title = (body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });

    let slug = body.slug ? slugify(body.slug) : slugify(title);

    // Ensure slug uniqueness
    const { data: existing } = await supabaseAdmin
      .from('blog_posts')
      .select('id')
      .eq('slug', slug)
      .single();

    if (existing) {
      slug = slug + '-' + Date.now().toString(36);
    }

    const now = new Date().toISOString();
    const post = {
      title,
      slug,
      excerpt: body.excerpt || '',
      content: body.content || '',
      status: body.status || 'draft',
      category: body.category || 'general',
      tags: body.tags || [],
      post_type: body.post_type || 'article',
      author_slug: body.author_slug || 'ryvite-team',
      reviewed_by: body.reviewed_by || null,
      last_reviewed_date: body.last_reviewed_date || null,
      featured_image: body.featured_image || null,
      seo: body.seo || null,
      featured: body.featured || false,
      related_slugs: body.related_slugs || [],
      published_date: body.published_date || now,
      modified_date: now,
      created_at: now,
      updated_at: now
    };

    const { data, error } = await supabaseAdmin
      .from('blog_posts')
      .insert(post)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true, post: data });
  }

  // --- UPDATE POST ---
  if (action === 'updatePost') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const body = req.body || {};
    const postId = body.postId || body.id;
    if (!postId) return res.status(400).json({ error: 'Missing postId' });

    // Fetch current post for slug comparison
    const { data: currentPost } = await supabaseAdmin
      .from('blog_posts')
      .select('slug')
      .eq('id', postId)
      .single();

    if (!currentPost) return res.status(404).json({ error: 'Post not found' });

    const updates = {};
    const fields = ['title', 'excerpt', 'content', 'status', 'category', 'tags', 'post_type',
      'author_slug', 'reviewed_by', 'last_reviewed_date', 'featured_image', 'seo',
      'featured', 'related_slugs', 'published_date'];

    fields.forEach(f => {
      if (body[f] !== undefined) updates[f] = body[f];
    });

    updates.modified_date = new Date().toISOString();
    updates.updated_at = new Date().toISOString();

    // Handle slug change with redirect
    if (body.slug !== undefined && body.slug !== currentPost.slug) {
      const newSlug = slugify(body.slug);

      // Check uniqueness
      const { data: slugExists } = await supabaseAdmin
        .from('blog_posts')
        .select('id')
        .eq('slug', newSlug)
        .neq('id', postId)
        .single();

      if (slugExists) return res.status(400).json({ error: 'Slug already in use' });

      updates.slug = newSlug;

      // Create redirect from old slug to new slug
      await supabaseAdmin
        .from('blog_redirects')
        .insert({
          old_slug: currentPost.slug,
          new_slug: newSlug,
          post_id: postId
        });

      // Flatten redirect chains: update any redirects pointing to the old slug
      await supabaseAdmin
        .from('blog_redirects')
        .update({ new_slug: newSlug })
        .eq('new_slug', currentPost.slug);
    }

    const { data, error } = await supabaseAdmin
      .from('blog_posts')
      .update(updates)
      .eq('id', postId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true, post: data });
  }

  // --- DELETE POST ---
  if (action === 'deletePost') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const postId = req.body?.postId;
    if (!postId) return res.status(400).json({ error: 'Missing postId' });

    const { error } = await supabaseAdmin
      .from('blog_posts')
      .delete()
      .eq('id', postId);

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  // --- BULK UPDATE STATUS ---
  if (action === 'bulkUpdateStatus') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const { postIds, status } = req.body || {};
    if (!postIds?.length) return res.status(400).json({ error: 'Missing postIds' });
    if (!['draft', 'published', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const { error } = await supabaseAdmin
      .from('blog_posts')
      .update({ status, modified_date: new Date().toISOString(), updated_at: new Date().toISOString() })
      .in('id', postIds);

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true, updated: postIds.length });
  }

  // --- BULK DELETE ---
  if (action === 'bulkDelete') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const { postIds } = req.body || {};
    if (!postIds?.length) return res.status(400).json({ error: 'Missing postIds' });

    const { error } = await supabaseAdmin
      .from('blog_posts')
      .delete()
      .in('id', postIds);

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true, deleted: postIds.length });
  }

  // --- GENERATE SEO TAGS ---
  if (action === 'generateSeoTags') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const { title, content, excerpt, slug } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const contentSnippet = (content || '').replace(/<[^>]*>/g, '').slice(0, 2000);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      temperature: 0.4,
      system: `You are an SEO specialist for Ryvite, a modern digital invitation and event planning platform. Generate SEO metadata for blog posts. Your tone is professional, warm, and approachable.

Rules:
- metaTitle: 50-60 characters, primary keyword near the start, include "Ryvite" if space allows
- metaDescription: 150-160 characters, compelling with a soft call-to-action
- ogTitle: 60-90 characters, can be more emotional/engaging than meta title
- ogDescription: 100-200 characters, optimized for social sharing
- No keyword stuffing, natural language only
- Focus on event planning, digital invitations, and RSVP themes when relevant

Respond in JSON format only:
{"metaTitle": "...", "metaDescription": "...", "ogTitle": "...", "ogDescription": "..."}`,
      messages: [{
        role: 'user',
        content: `Generate SEO metadata for this blog post:

Title: ${title}
Slug: ${slug || slugify(title)}
Excerpt: ${excerpt || ''}
Content (first 2000 chars): ${contentSnippet}`
      }]
    });

    // Log blog SEO generation to generation_log for cost tracking
    await supabaseAdmin.from('generation_log').insert({
      event_id: null, user_id: admin.id,
      prompt: 'blog: generateSeoTags for "' + (title || '').substring(0, 100) + '"',
      model: 'claude-sonnet-4-20250514',
      input_tokens: response.usage?.input_tokens || 0,
      output_tokens: response.usage?.output_tokens || 0,
      latency_ms: 0, status: 'success', is_tweak: false
    }).catch(e => console.error('Blog SEO generation_log insert failed:', e.message));

    try {
      const text = response.content[0].text.trim();
      // Strip markdown fences if present
      const jsonStr = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
      const seo = JSON.parse(jsonStr);
      return res.status(200).json({ success: true, seo });
    } catch (parseErr) {
      console.error('[blog] Failed to parse AI SEO response:', parseErr.message, response.content[0].text?.substring(0, 200));
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }
  }

  // --- GENERATE FEATURED IMAGE (placeholder) ---
  if (action === 'generateFeaturedImage' || action === 'bulkGenerateImages') {
    return res.status(501).json({
      error: 'Image generation API not configured. Set IMAGE_GEN_API_KEY environment variable.'
    });
  }

  // --- LIST CATEGORIES (admin) ---
  if (action === 'listCategories') {
    const { data: categories, error } = await supabaseAdmin
      .from('blog_categories')
      .select('*')
      .order('name');

    if (error) return res.status(400).json({ error: error.message });

    // Get post counts per category
    const { data: posts } = await supabaseAdmin
      .from('blog_posts')
      .select('category');

    const counts = {};
    (posts || []).forEach(p => {
      counts[p.category] = (counts[p.category] || 0) + 1;
    });

    const result = (categories || []).map(c => ({
      ...c,
      postCount: counts[c.slug] || 0
    }));

    return res.status(200).json({ success: true, categories: result });
  }

  // --- CREATE CATEGORY ---
  if (action === 'createCategory') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const { name, description } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const slug = slugify(name);
    const { data, error } = await supabaseAdmin
      .from('blog_categories')
      .insert({ name: name.trim(), slug, description: description || '' })
      .select()
      .single();

    if (error) {
      if (error.message.includes('duplicate') || error.message.includes('unique')) {
        return res.status(400).json({ error: 'Category name or slug already exists' });
      }
      return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ success: true, category: data });
  }

  // --- UPDATE CATEGORY ---
  if (action === 'updateCategory') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const { id, name, description } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing category id' });

    const updates = {};
    if (name !== undefined) {
      updates.name = name.trim();
      updates.slug = slugify(name);
    }
    if (description !== undefined) updates.description = description;

    const { data, error } = await supabaseAdmin
      .from('blog_categories')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true, category: data });
  }

  // --- DELETE CATEGORY ---
  if (action === 'deleteCategory') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing category id' });

    // Get category slug first
    const { data: cat } = await supabaseAdmin
      .from('blog_categories')
      .select('slug')
      .eq('id', id)
      .single();

    if (cat) {
      // Check if any posts use this category
      const { count } = await supabaseAdmin
        .from('blog_posts')
        .select('id', { count: 'exact', head: true })
        .eq('category', cat.slug);

      if (count > 0) {
        return res.status(400).json({ error: `Cannot delete category with ${count} post(s). Reassign posts first.` });
      }
    }

    const { error } = await supabaseAdmin
      .from('blog_categories')
      .delete()
      .eq('id', id);

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  // --- BULK IMPORT ---
  if (action === 'bulkImport') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const { posts: rows } = req.body || {};
    if (!rows?.length) return res.status(400).json({ error: 'No posts to import' });

    const results = { created: 0, skipped: 0, seoGenerated: 0, errors: [] };

    // Process in batches of 10
    for (let i = 0; i < rows.length; i += 10) {
      const batch = rows.slice(i, i + 10);

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const rowIndex = i + j + 1;

        try {
          if (!row.title?.trim()) {
            results.errors.push({ row: rowIndex, error: 'Missing title' });
            continue;
          }

          const slug = row.slug ? slugify(row.slug) : slugify(row.title);

          // Check duplicate
          const { data: existing } = await supabaseAdmin
            .from('blog_posts')
            .select('id')
            .eq('slug', slug)
            .single();

          if (existing) {
            results.skipped++;
            continue;
          }

          const now = new Date().toISOString();
          const post = {
            title: row.title.trim(),
            slug,
            excerpt: row.excerpt || '',
            content: row.content || '',
            status: row.status || 'draft',
            category: row.category || 'general',
            tags: row.tags || [],
            post_type: row.post_type || 'article',
            author_slug: row.author_slug || 'ryvite-team',
            featured: row.featured === true || row.featured === 'true',
            featured_image: row.featured_image_src ? {
              src: row.featured_image_src,
              alt: row.featured_image_alt || row.title,
              width: parseInt(row.featured_image_width) || 1200,
              height: parseInt(row.featured_image_height) || 630
            } : null,
            related_slugs: row.related_slugs || [],
            published_date: now,
            modified_date: now,
            created_at: now,
            updated_at: now
          };

          const { data: created, error } = await supabaseAdmin
            .from('blog_posts')
            .insert(post)
            .select()
            .single();

          if (error) {
            results.errors.push({ row: rowIndex, error: error.message });
            continue;
          }

          results.created++;

          // Generate SEO if requested
          if (row.generate_seo === true || row.generate_seo === 'true') {
            try {
              const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
              const contentSnippet = (post.content || '').replace(/<[^>]*>/g, '').slice(0, 2000);

              const seoResponse = await anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 512,
                temperature: 0.4,
                system: `You are an SEO specialist for Ryvite. Generate SEO metadata for blog posts. Respond in JSON only: {"metaTitle": "...", "metaDescription": "...", "ogTitle": "...", "ogDescription": "..."}`,
                messages: [{
                  role: 'user',
                  content: `Title: ${post.title}\nExcerpt: ${post.excerpt}\nContent: ${contentSnippet}`
                }]
              });

              const seoText = seoResponse.content[0].text.trim();
              const seoJson = JSON.parse(seoText.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim());

              await supabaseAdmin
                .from('blog_posts')
                .update({ seo: seoJson })
                .eq('id', created.id);

              // Log bulk blog SEO call to generation_log
              await supabaseAdmin.from('generation_log').insert({
                event_id: null, user_id: admin.id,
                prompt: 'blog: bulk SEO for "' + (post.title || '').substring(0, 100) + '"',
                model: 'claude-sonnet-4-20250514',
                input_tokens: seoResponse.usage?.input_tokens || 0,
                output_tokens: seoResponse.usage?.output_tokens || 0,
                latency_ms: 0, status: 'success', is_tweak: false
              }).catch(() => {});

              results.seoGenerated++;
            } catch (seoErr) {
              // SEO generation failure is non-fatal
              results.errors.push({ row: rowIndex, error: 'SEO generation failed: ' + seoErr.message });
            }
          }
        } catch (err) {
          results.errors.push({ row: rowIndex, error: err.message });
        }
      }
    }

    return res.status(200).json({ success: true, results });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body?.action;
  if (!action) return res.status(400).json({ error: 'Missing action parameter' });

  try {
    // Public actions (no auth)
    const publicActions = ['listPublished', 'getBySlug', 'getRedirect', 'getFeatured', 'getAllTags', 'getAllCategories', 'rss'];
    if (publicActions.includes(action)) {
      const result = await handlePublicAction(action, req, res);
      if (result === null) {
        return res.status(400).json({ error: 'Unknown action' });
      }
      return;
    }

    // Admin actions (auth required)
    const authResult = await verifyAdmin(req);
    if (authResult.error === 'no_token' || authResult.error === 'invalid_token') {
      return res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
    }
    if (authResult.error === 'not_admin') {
      return res.status(403).json({ error: 'Forbidden — admin access required' });
    }

    return await handleAdminAction(action, req, res, authResult.user);
  } catch (err) {
    console.error('Blog API error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
