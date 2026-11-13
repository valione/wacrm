/**
 * Regras do /api/health — o monitor externo (UptimeRobot) chama a rota a
 * cada poucos minutos e alerta quando ela não responde 200.
 *
 * Cada verificação além do banco é ligada por instalação, por variável de
 * ambiente, porque nem toda instalação está em uso:
 *   HEALTH_REQUIRE_WHATSAPP=1      → WhatsApp precisa estar conectado
 *   HEALTH_MAX_SILENCE_HOURS=4     → alerta se nenhum cliente escreveu nas
 *                                    últimas N horas, só dentro do horário
 *   HEALTH_BUSINESS_HOURS=8-20     → janela do silêncio (hora de Brasília,
 *                                    seg–sex); padrão 8-20
 */

export interface HealthRules {
  requireWhatsapp: boolean
  maxSilenceHours: number | null
  businessStart: number
  businessEnd: number
}

export function rulesFromEnv(env: Record<string, string | undefined>): HealthRules {
  const silence = Number(env.HEALTH_MAX_SILENCE_HOURS)
  const [start, end] = (env.HEALTH_BUSINESS_HOURS ?? '8-20').split('-').map(Number)
  return {
    requireWhatsapp: env.HEALTH_REQUIRE_WHATSAPP === '1',
    maxSilenceHours: silence > 0 ? silence : null,
    businessStart: Number.isFinite(start) ? start : 8,
    businessEnd: Number.isFinite(end) ? end : 20,
  }
}

export interface HealthInput {
  dbOk: boolean
  /** status de cada linha de whatsapp_config */
  whatsappStatuses: string[]
  lastCustomerMessageAt: string | null
  now: Date
}

/** Hora e dia da semana em Brasília (0 = domingo). */
function brasilia(now: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
  return { hour, weekday }
}

export function evaluateHealth(input: HealthInput, rules: HealthRules): { ok: boolean; problems: string[] } {
  const problems: string[] = []

  if (!input.dbOk) {
    problems.push('banco de dados não respondeu')
    return { ok: false, problems }
  }

  if (rules.requireWhatsapp) {
    if (input.whatsappStatuses.length === 0) problems.push('WhatsApp não configurado')
    else if (input.whatsappStatuses.some((s) => s !== 'connected')) problems.push('WhatsApp desconectado')
  }

  if (rules.maxSilenceHours !== null) {
    const { hour, weekday } = brasilia(input.now)
    const weekdayOk = weekday >= 1 && weekday <= 5
    // Só cobra silêncio depois de N horas de expediente — evita alarme
    // às 8h de segunda por causa do fim de semana quieto.
    const inWindow = weekdayOk && hour >= rules.businessStart + rules.maxSilenceHours && hour < rules.businessEnd
    if (inWindow) {
      const last = input.lastCustomerMessageAt ? new Date(input.lastCustomerMessageAt).getTime() : 0
      const hoursSilent = (input.now.getTime() - last) / 3_600_000
      if (hoursSilent > rules.maxSilenceHours) {
        problems.push(`nenhuma mensagem de cliente há mais de ${rules.maxSilenceHours} h`)
      }
    }
  }

  return { ok: problems.length === 0, problems }
}
