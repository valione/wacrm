/**
 * Rótulos por vertical de mercado. O produto é um só e as instalações
 * compilam do mesmo código, então textos que mudam por cliente não podem
 * viver dentro do componente — vêm daqui, ligados por env.
 *
 * Hoje só existe a vertical `educacao`, que troca "Empresa" por "Curso de
 * interesse" no contato (Campos Salles, Anhembi Morumbi). Instalação sem
 * NEXT_PUBLIC_VERTICAL (Display4) recebe o dicionário intacto.
 *
 * NEXT_PUBLIC_* é inlinado no BUILD por substituição textual — as duas envs
 * são lidas por extenso, nunca por índice dinâmico.
 */

export interface VerticalOptions {
  /** Sobrepõe NEXT_PUBLIC_VERTICAL (usado nos testes). */
  vertical?: string
  /** Sobrepõe NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE (usado nos testes). */
  fieldExample?: string
}

type TabelaDeRotulos = Record<string, string>

/** Chave do exemplo que aparece dentro do campo — valor vem da instalação. */
const EXEMPLO_DO_CAMPO = 'Contacts.form.companyPlaceholder'

const EDUCACAO_PT: TabelaDeRotulos = {
  'Contacts.form.companyLabel': 'Curso de interesse',
  'Contacts.detailView.company': 'Curso de interesse',
  'Contacts.page.tableColumns.company': 'Curso de interesse',
  'Contacts.importModal.columns.company': 'Curso de interesse',
  'Contacts.importModal.desc':
    'Envie um CSV com a coluna obrigatória <phoneCode>phone</phoneCode>. Opcionais: <nameCode>name</nameCode>, <emailCode>email</emailCode>, <companyCode>curso</companyCode>, <tagsCode>tags</tagsCode> (separadas por vírgula; use aspas em células com várias tags).',
  'Inbox.conversationList.company': 'Curso',
  'Inbox.conversationList.allCompanies': 'Todos os cursos',
  'Automations.builder.fields.company': 'Curso de interesse',
  'Automations.builder.config.placeholderContact': 'nome / e-mail / curso',
  'Flows.builder.form.varKeyPlaceholder': 'ex.: nome, email, curso',
}

const EDUCACAO_EN: TabelaDeRotulos = {
  'Contacts.form.companyLabel': 'Course of interest',
  'Contacts.detailView.company': 'Course of interest',
  'Contacts.page.tableColumns.company': 'Course of interest',
  'Contacts.importModal.columns.company': 'Course of interest',
  'Contacts.importModal.desc':
    'Upload a CSV with a required <phoneCode>phone</phoneCode> column. Optional: <nameCode>name</nameCode>, <emailCode>email</emailCode>, <companyCode>course</companyCode>, <tagsCode>tags</tagsCode> (comma-separated; quote multi-tag cells).',
  'Inbox.conversationList.company': 'Course',
  'Inbox.conversationList.allCompanies': 'All courses',
  'Automations.builder.fields.company': 'Course of interest',
  'Automations.builder.config.placeholderContact': 'name / email / course',
  'Flows.builder.form.varKeyPlaceholder': 'e.g. name, email, course',
}

const TABELAS: Record<string, Record<string, TabelaDeRotulos>> = {
  educacao: { pt: EDUCACAO_PT, en: EDUCACAO_EN },
}

/** Exemplo usado quando a instalação não define o seu. */
const EXEMPLO_PADRAO: Record<string, Record<string, string>> = {
  educacao: { pt: 'Administração', en: 'Business Administration' },
}

/**
 * Grava `valor` em `caminho` devolvendo uma cópia — clona só os níveis do
 * caminho (o resto do dicionário é compartilhado). Caminho inexistente
 * devolve o objeto original: se o upstream renomear a chave, o rótulo deixa
 * de ser trocado em vez de nascer uma chave fantasma. O teste
 * "todo caminho trocado existe hoje" avisa quando isso acontecer.
 */
function gravarCaminho<T extends object>(obj: T, caminho: string, valor: string): T {
  const partes = caminho.split('.')
  const raiz: Record<string, unknown> = { ...obj } as Record<string, unknown>
  let cursor = raiz

  for (let i = 0; i < partes.length - 1; i++) {
    const filho = cursor[partes[i]]
    if (!filho || typeof filho !== 'object') return obj
    const copia = { ...(filho as Record<string, unknown>) }
    cursor[partes[i]] = copia
    cursor = copia
  }

  const folha = partes[partes.length - 1]
  if (typeof cursor[folha] !== 'string') return obj
  cursor[folha] = valor
  return raiz as T
}

export function applyVerticalLabels<T extends object>(
  messages: T,
  locale: string,
  options: VerticalOptions = {},
): T {
  const vertical = (options.vertical ?? process.env.NEXT_PUBLIC_VERTICAL ?? '').trim()
  if (!vertical) return messages

  const tabela = TABELAS[vertical]?.[locale]
  if (!tabela) return messages

  let resultado = messages
  for (const [caminho, valor] of Object.entries(tabela)) {
    resultado = gravarCaminho(resultado, caminho, valor)
  }

  const exemplo =
    (options.fieldExample ?? process.env.NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE ?? '').trim() ||
    EXEMPLO_PADRAO[vertical]?.[locale]
  if (exemplo) {
    resultado = gravarCaminho(resultado, EXEMPLO_DO_CAMPO, exemplo)
  }

  return resultado
}
