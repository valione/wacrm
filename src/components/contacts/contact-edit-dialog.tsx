"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type { Contact, ContactTag } from "@/types";
import { isReadyToEdit } from "@/lib/contacts/edit-dialog-state";
import { ContactForm } from "@/components/contacts/contact-form";

interface ContactEditDialogProps {
  contactId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Recebe o contato relido depois do save — quem chamou usa para
   *  atualizar a tela sem recarregar. */
  onSaved: (contact: Contact) => void;
}

/**
 * Abre o ContactForm de qualquer lugar onde um contato apareça, sem o
 * chamador precisar carregar contato e tags. A espera pelas tags é a razão
 * de este envelope existir — ver isReadyToEdit.
 */
export function ContactEditDialog({
  contactId,
  open,
  onOpenChange,
  onSaved,
}: ContactEditDialogProps) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [tags, setTags] = useState<ContactTag[] | null>(null);

  const fetchContact = useCallback(async (): Promise<Contact | null> => {
    if (!contactId) return null;
    const supabase = createClient();
    const { data } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .maybeSingle();
    return data ?? null;
  }, [contactId]);

  // Carrega contato e tags juntos. Enquanto `tags` for null o formulário
  // NÃO monta.
  useEffect(() => {
    if (!open || !contactId) {
      setContact(null);
      setTags(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [contactRes, tagsRes] = await Promise.all([
        supabase.from("contacts").select("*").eq("id", contactId).maybeSingle(),
        supabase.from("contact_tags").select("*").eq("contact_id", contactId),
      ]);
      if (cancelled) return;
      if (contactRes.error || tagsRes.error || !contactRes.data) {
        toast.error(
          contactRes.error?.message ?? tagsRes.error?.message ?? "Contact not found",
        );
        onOpenChange(false);
        return;
      }
      setContact(contactRes.data);
      setTags(tagsRes.data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, onOpenChange]);

  const handleSaved = useCallback(async () => {
    const fresh = await fetchContact();
    if (fresh) onSaved(fresh);
  }, [fetchContact, onSaved]);

  if (!isReadyToEdit(contact, tags)) return null;

  return (
    <ContactForm
      open={open}
      onOpenChange={onOpenChange}
      contact={contact}
      contactTags={tags ?? []}
      onSaved={handleSaved}
    />
  );
}
