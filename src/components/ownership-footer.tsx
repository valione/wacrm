import { APP_NAME } from '@/lib/branding'

/**
 * Assinatura de propriedade dos rodapés (sidebar, login). Vive em um
 * componente (e não numa string em branding.ts) porque o "Valione
 * Intelligence" é itálico — precisa de markup, não só texto.
 */
export function OwnershipFooter({ className }: { className?: string }) {
  return (
    <p className={className}>
      {APP_NAME} by <em>Valione Intelligence</em>.
    </p>
  )
}
