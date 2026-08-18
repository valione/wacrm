import { describe, expect, it } from 'vitest'
import ptMessages from '../../messages/pt.json'
import enMessages from '../../messages/en.json'
import { applyVerticalLabels } from './vertical'

/** Achata o dicionário em { 'A.B.c': 'texto' } para comparar chave a chave. */
function flatten(
  value: unknown,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  if (typeof value === 'string') {
    out[prefix] = value
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out)
    }
  }
  return out
}

/** Caminhos que a vertical `educacao` troca, fora o exemplo do campo. */
const CAMINHOS_TROCADOS = [
  'Contacts.form.companyLabel',
  'Contacts.detailView.company',
  'Contacts.page.tableColumns.company',
  'Contacts.importModal.columns.company',
  'Contacts.importModal.desc',
  'Inbox.conversationList.company',
  'Inbox.conversationList.allCompanies',
  'Automations.builder.fields.company',
  'Flows.builder.form.varKeyPlaceholder',
]

const EXEMPLO_DO_CAMPO = 'Contacts.form.companyPlaceholder'

describe('applyVerticalLabels — sem vertical', () => {
  it('devolve o mesmo objeto quando a vertical está vazia', () => {
    const out = applyVerticalLabels(ptMessages, 'pt', { vertical: '' })
    expect(out).toBe(ptMessages)
  })

  it('devolve o mesmo objeto quando a vertical é desconhecida', () => {
    const out = applyVerticalLabels(ptMessages, 'pt', { vertical: 'imobiliaria' })
    expect(out).toBe(ptMessages)
  })

  it('devolve o mesmo objeto quando o locale não tem tabela', () => {
    const out = applyVerticalLabels(ptMessages, 'fr', { vertical: 'educacao' })
    expect(out).toBe(ptMessages)
  })
})

describe('applyVerticalLabels — educacao/pt', () => {
  const out = applyVerticalLabels(ptMessages, 'pt', {
    vertical: 'educacao',
    fieldExample: 'Direito',
  })
  const antes = flatten(ptMessages)
  const depois = flatten(out)

  it('renomeia o campo no formulário, na ficha e na tabela', () => {
    expect(depois['Contacts.form.companyLabel']).toBe('Curso de interesse')
    expect(depois['Contacts.detailView.company']).toBe('Curso de interesse')
    expect(depois['Contacts.page.tableColumns.company']).toBe('Curso de interesse')
  })

  it('usa singular curto no filtro do Inbox e plural correto no "todos"', () => {
    expect(depois['Inbox.conversationList.company']).toBe('Curso')
    expect(depois['Inbox.conversationList.allCompanies']).toBe('Todos os cursos')
  })

  it('usa o exemplo da instalação dentro do campo', () => {
    expect(depois[EXEMPLO_DO_CAMPO]).toBe('Direito')
  })

  it('cai no exemplo padrão quando a instalação não define um', () => {
    const semExemplo = applyVerticalLabels(ptMessages, 'pt', {
      vertical: 'educacao',
      fieldExample: '',
    })
    expect(flatten(semExemplo)[EXEMPLO_DO_CAMPO]).toBe('Administração')
  })

  it('manda o CSV citar a coluna curso', () => {
    expect(depois['Contacts.importModal.desc']).toContain('<companyCode>curso</companyCode>')
    expect(depois['Contacts.importModal.desc']).not.toContain('<companyCode>company</companyCode>')
  })

  it('não muda nenhuma chave além das previstas', () => {
    const previstas = new Set([...CAMINHOS_TROCADOS, EXEMPLO_DO_CAMPO])
    const diferentes = Object.keys(antes).filter((k) => antes[k] !== depois[k])
    expect(diferentes.sort()).toEqual([...previstas].sort())
  })

  it('não cria nem remove chaves', () => {
    expect(Object.keys(depois).sort()).toEqual(Object.keys(antes).sort())
  })

  it('preserva os dois textos que citam empresa por coincidência', () => {
    expect(depois['Settings.profile.signatureHint']).toBe(
      antes['Settings.profile.signatureHint'],
    )
    expect(depois['Settings.aiConfig.promptPlaceholder']).toBe(
      antes['Settings.aiConfig.promptPlaceholder'],
    )
  })

  it('não muta o dicionário original', () => {
    expect(flatten(ptMessages)['Contacts.form.companyLabel']).toBe('Empresa')
  })
})

describe('applyVerticalLabels — educacao/en', () => {
  it('traduz os rótulos equivalentes', () => {
    const out = flatten(
      applyVerticalLabels(enMessages, 'en', { vertical: 'educacao', fieldExample: '' }),
    )
    expect(out['Contacts.form.companyLabel']).toBe('Course of interest')
    expect(out['Inbox.conversationList.allCompanies']).toBe('All courses')
  })
})

describe('tabela de rótulos vs. dicionário real', () => {
  it('todo caminho trocado existe hoje em pt e en', () => {
    for (const caminho of [...CAMINHOS_TROCADOS, EXEMPLO_DO_CAMPO]) {
      expect(flatten(ptMessages)[caminho], `pt: ${caminho}`).toBeTypeOf('string')
      expect(flatten(enMessages)[caminho], `en: ${caminho}`).toBeTypeOf('string')
    }
  })
})
