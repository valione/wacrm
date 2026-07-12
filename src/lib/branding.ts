// Identidade white-label da instalação. O modelo de negócio é uma
// instalação por cliente (sempre administrada pela Valione), então o nome
// do app vem de env — duplicar o app para outro cliente é trocar
// NEXT_PUBLIC_APP_NAME no .env, sem tocar em código. A assinatura de
// propriedade é fixa: ela marca a dona do software em toda instalação.
//
// NEXT_PUBLIC_* é inlinado no BUILD — trocar o valor exige rebuild.

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Display4 | CRM'

// A assinatura de propriedade ("<nome> by Valione Intelligence.") vive em
// src/components/ownership-footer.tsx — tem markup (itálico), não é string.
