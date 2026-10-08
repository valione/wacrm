#!/usr/bin/env node
/**
 * Mescla os dicionários de tradução durante o merge do upstream.
 *
 * Modo 1 — merge (padrão): node scripts/merge-messages.mjs <locale>
 * Base: a versão do upstream (tradução oficial, decisão do Miguel em
 * 2026-09-15). Por cima, reaplica as chaves que só existem no fork — são
 * textos de funcionalidades que o upstream não tem (marketing, nova
 * conversa, excluir conversa, origem do contato). Sem isso, a interface
 * fica com buracos onde o dicionário não responde.
 * Lê as duas versões do git (estágios do merge) e escreve messages/<locale>.json.
 *
 * Modo 2 — fallback: node scripts/merge-messages.mjs fallback <locale>
 * Para locales que o fork nunca traduziu (es, ko): preenche, com o valor de
 * en.json, toda chave que exista em en.json e não exista em messages/<locale>.json.
 * Nenhuma chave que o locale já tenha é tocada. Usado para satisfazer a
 * paridade de chaves (src/i18n/messages.test.ts) sem fingir uma tradução
 * que não existe — a UI degrada para inglês legível em vez de mostrar o
 * keypath cru. Lê e escreve direto em messages/, sem tocar no git.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const modo = process.argv[2] === 'fallback' ? 'fallback' : 'merge'

if (modo === 'fallback') {
  const locale = process.argv[3]
  if (!locale) {
    console.error('uso: node scripts/merge-messages.mjs fallback <locale>')
    process.exit(2)
  }

  const en = JSON.parse(readFileSync('messages/en.json', 'utf8'))
  const alvo = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'))

  /**
   * Percorre en.json na sua própria ordem e nesting. Onde o alvo já tem a
   * chave (string ou objeto), preserva o valor do alvo tal como está —
   * recursando em objetos para não sobrescrever irmãs já traduzidas.
   * Onde falta, copia a subárvore inteira de en.json.
   */
  function preencherFaltantes(baseEn, valorAlvo) {
    if (typeof baseEn === 'string') {
      return typeof valorAlvo === 'string' ? valorAlvo : baseEn
    }
    if (baseEn && typeof baseEn === 'object') {
      const objAlvo = valorAlvo && typeof valorAlvo === 'object' ? valorAlvo : {}
      const saida = {}
      for (const [k, v] of Object.entries(baseEn)) {
        saida[k] = preencherFaltantes(v, objAlvo[k])
      }
      // Preserva qualquer chave extra que o alvo já tivesse (não deveria
      // existir hoje — es/ko não têm chaves órfãs — mas não é motivo para
      // apagar dado do usuário se um dia existir).
      for (const [k, v] of Object.entries(objAlvo)) {
        if (!(k in saida)) saida[k] = v
      }
      return saida
    }
    return valorAlvo
  }

  const achatar = (valor, prefixo = '', saida = {}) => {
    if (typeof valor === 'string') {
      saida[prefixo] = valor
      return saida
    }
    if (valor && typeof valor === 'object') {
      for (const [k, v] of Object.entries(valor)) achatar(v, prefixo ? `${prefixo}.${k}` : k, saida)
    }
    return saida
  }

  const antes = Object.keys(achatar(alvo)).length
  const resultado = preencherFaltantes(en, alvo)
  const depois = Object.keys(achatar(resultado)).length

  writeFileSync(`messages/${locale}.json`, JSON.stringify(resultado, null, 2) + '\n')

  console.log(`${locale}: chaves antes ${antes}`)
  console.log(`${locale}: preenchidas com fallback em inglês ${depois - antes}`)
  console.log(`${locale}: total ${depois}`)
  process.exit(0)
}

const locale = process.argv[2]
if (!locale) {
  console.error('uso: node scripts/merge-messages.mjs <locale>')
  process.exit(2)
}

const ler = (ref) =>
  JSON.parse(execFileSync('git', ['show', `${ref}:messages/${locale}.json`], { encoding: 'utf8' }))

const fork = ler('HEAD')
const upstream = ler('MERGE_HEAD')

/** Achata em { 'A.B.c': 'texto' } para comparar chave a chave. */
function achatar(valor, prefixo = '', saida = {}) {
  if (typeof valor === 'string') {
    saida[prefixo] = valor
    return saida
  }
  if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      achatar(v, prefixo ? `${prefixo}.${k}` : k, saida)
    }
  }
  return saida
}

/** Grava 'A.B.c' num objeto aninhado, criando os níveis que faltarem. */
function gravar(obj, caminho, valor) {
  const partes = caminho.split('.')
  let cursor = obj
  for (let i = 0; i < partes.length - 1; i++) {
    if (typeof cursor[partes[i]] !== 'object' || cursor[partes[i]] === null) {
      cursor[partes[i]] = {}
    }
    cursor = cursor[partes[i]]
  }
  cursor[partes[partes.length - 1]] = valor
}

const planoFork = achatar(fork)
const planoUpstream = achatar(upstream)
const soDoFork = Object.keys(planoFork).filter((k) => !(k in planoUpstream))

const resultado = JSON.parse(JSON.stringify(upstream))
for (const caminho of soDoFork) {
  gravar(resultado, caminho, planoFork[caminho])
}

writeFileSync(`messages/${locale}.json`, JSON.stringify(resultado, null, 2) + '\n')

console.log(`${locale}: base upstream ${Object.keys(planoUpstream).length} chaves`)
console.log(`${locale}: reaplicadas do fork ${soDoFork.length} chaves`)
console.log(`${locale}: total ${Object.keys(achatar(resultado)).length} chaves`)
