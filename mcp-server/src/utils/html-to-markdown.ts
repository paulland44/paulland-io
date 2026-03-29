/**
 * HTML to Markdown conversion — ported from functions/api/[[path]].js
 * Used for feed item capture (article extraction).
 */

export function extractArticleContent(html: string): {
  title: string;
  description: string;
  body: string;
  imageUrl: string | null;
} {
  // Extract metadata from head
  let title = 'Untitled';
  let description = '';
  let imageUrl: string | null = null;

  const ogTitle = html.match(
    /<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i
  );
  if (ogTitle) {
    title = ogTitle[1];
  } else {
    const htmlTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (htmlTitle) title = htmlTitle[1].trim();
  }

  const ogDesc = html.match(
    /<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i
  );
  const metaDesc = html.match(
    /<meta\s+name="description"\s+content="([^"]+)"/i
  );
  if (ogDesc) description = ogDesc[1];
  else if (metaDesc) description = metaDesc[1];

  const ogImage = html.match(
    /<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i
  );
  imageUrl = ogImage ? ogImage[1] : null;

  // Extract article content
  let contentHtml = '';
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const roleMainMatch = html.match(
    /<[^>]+role="main"[^>]*>([\s\S]*?)<\/[^>]+>/i
  );
  const contentDivMatch = html.match(
    /<div[^>]+class="[^"]*(?:post-content|article-content|entry-content|post-body|article-body|story-body|content-body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );

  contentHtml =
    contentDivMatch?.[1] ||
    articleMatch?.[1] ||
    roleMainMatch?.[1] ||
    mainMatch?.[1] ||
    '';

  let body = '';
  if (contentHtml) {
    body = htmlToMarkdown(contentHtml);
  }

  return { title, description, body, imageUrl };
}

export function htmlToMarkdown(html: string): string {
  return (
    html
      // Headings
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
      .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
      .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
      .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')
      // Paragraphs & breaks
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // Lists
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
      .replace(/<\/?[ou]l[^>]*>/gi, '\n')
      // Links & images
      .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
      .replace(
        /<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi,
        '![$2]($1)'
      )
      .replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, '![]($1)')
      // Formatting
      .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
      .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
      .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
      .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
      .replace(
        /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
        '\n> $1\n'
      )
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
      // Remove script, style, nav, footer, aside
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
      // Remove remaining HTML tags
      .replace(/<[^>]+>/g, '')
      // Decode entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&rsquo;/g, "'")
      .replace(/&lsquo;/g, "'")
      .replace(/&rdquo;/g, '"')
      .replace(/&ldquo;/g, '"')
      .replace(/&mdash;/g, '\u2014')
      .replace(/&ndash;/g, '\u2013')
      .replace(/&hellip;/g, '\u2026')
      // Clean up whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
