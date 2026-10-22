import StudioGameHost from '@/components/studio/StudioGameHost';

/** Launch URL del Hub: /studio/<gameId>?mode=demo|real&session=... */
export default async function StudioGamePage({
  params,
  searchParams,
}: {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<{ mode?: string | string[]; session?: string | string[] }>;
}) {
  const { gameId } = await params;
  const sp = await searchParams;
  const first = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
  const session = first(sp.session) || undefined;
  const mode: 'real' | 'demo' = first(sp.mode) === 'real' ? 'real' : 'demo';
  return <StudioGameHost gameId={decodeURIComponent(gameId)} mode={mode} session={session} />;
}
