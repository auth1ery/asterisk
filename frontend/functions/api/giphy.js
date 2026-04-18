export async function onRequest({ request, env }) {
  const url      = new URL(request.url);
  const endpoint = url.searchParams.get('endpoint') || 'trending';
  const q        = url.searchParams.get('q')        || '';
  const limit    = url.searchParams.get('limit')    || '30';

  if (!env.GIPHY_KEY) {
    return new Response(JSON.stringify({ error: 'GIPHY_KEY not set' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const base   = 'https://api.giphy.com/v1/gifs';
  const target = endpoint === 'search' && q
    ? `${base}/search?api_key=${env.GIPHY_KEY}&q=${encodeURIComponent(q)}&limit=${limit}&rating=pg`
    : `${base}/trending?api_key=${env.GIPHY_KEY}&limit=${limit}&rating=pg`;

  const res  = await fetch(target);
  const data = await res.json();

  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': endpoint === 'trending' ? 'public, max-age=300' : 'no-store',
    }
  });
}
