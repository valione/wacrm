// Helper neutro (sem dependência de nenhum provedor específico) para montar
// a URL do proxy de mídia autenticado que o CRM serve ao navegador.
//
// Extraído de waha-webhook.ts (onde nasceu) para a Task 4: o webhook Uazapi
// e o proxy `src/app/api/whatsapp/uazapi/media/route.ts` precisam do MESMO
// helper que a WAHA já usa, e importar `waha-webhook.ts` a partir do código
// da Uazapi criaria um acoplamento sem sentido (um provedor "precisando" do
// outro). `waha-webhook.ts` e `src/app/api/whatsapp/waha/media/route.ts`
// continuam importando `buildMediaProxyUrl` do caminho antigo — ele agora só
// re-exporta a partir daqui — então nenhum call site existente muda.
//
// Usado em dois lugares que PRECISAM produzir a mesma string byte a byte:
// a normalização de cada provedor (grava em messages.media_url) e a
// checagem de autorização por conta do respectivo proxy (reconstrói a
// partir do `src` decodificado e busca a mensagem correspondente via RLS).
export function buildMediaProxyUrl(mediaProxyPath: string, src: string): string {
  return `${mediaProxyPath}?src=${encodeURIComponent(src)}`
}
