// Identidade white-label da instalação. O modelo de negócio é uma
// instalação por cliente (sempre administrada pela Valione), então o nome
// do app vem de env — duplicar o app para outro cliente é trocar
// NEXT_PUBLIC_APP_NAME no .env, sem tocar em código. A assinatura de
// propriedade é fixa: ela marca a dona do software em toda instalação.
//
// NEXT_PUBLIC_* é inlinado no BUILD — trocar o valor exige rebuild.

import packageJson from '../../package.json'

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Display4 | CRM'

/**
 * Versão da instalação — fonte única é o package.json ("1.1.0" exibe
 * "v1.1"). Convenção do projeto: minor (1.1 → 1.2) a cada deploy com
 * ajustes; major (2.0) em mudanças grandes. Histórico no CHANGELOG.md;
 * cada versão publicada ganha uma tag git (v1.0.0, v1.1.0, ...).
 */
export const APP_VERSION = 'v' + packageJson.version.split('.').slice(0, 2).join('.')

// A assinatura de propriedade ("<nome> by Valione Intelligence.") vive em
// src/components/ownership-footer.tsx — tem markup (itálico), não é string.
