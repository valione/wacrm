//
// Quando é seguro montar o ContactForm para edição.
//
// `ContactForm` popula as tags selecionadas num efeito que roda ao abrir
// (deps `[open, contact]`, NÃO `contactTags`) e, ao salvar, apaga todas as
// linhas de contact_tags e regrava as selecionadas. Montar o formulário
// antes de as tags chegarem abre com nenhuma marcada — e salvar apaga as
// tags do contato em silêncio, sem erro e sem aviso.
//
// Por isso `null` (ainda carregando) e `[]` (carregado, contato sem tags)
// são estados diferentes: só o segundo libera.

import type { Contact, ContactTag } from "@/types";

export function isReadyToEdit(
  contact: Contact | null,
  tags: ContactTag[] | null,
): boolean {
  return !!contact && tags !== null;
}
