"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { findExistingContact } from "@/lib/contacts/dedupe";
import { isValidE164, normalizePhone } from "@/lib/whatsapp/phone-utils";
import type { Contact } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Search, Send, TriangleAlert, UserPlus, X } from "lucide-react";

/** Contact shape the picker needs — a subset of `Contact`. */
type PickerContact = Pick<Contact, "id" | "name" | "phone">;

/**
 * Strip the characters PostgREST treats as syntax inside `.or(...)`:
 * a comma starts a new condition, parens group them, and a dot
 * separates column/operator/value. A contact search for "Silva, Ana"
 * would otherwise be parsed as two malformed conditions and 400.
 * RLS still scopes the query to the account either way — this is about
 * the filter parsing correctly, not about access.
 */
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,().*\\]/g, " ").trim();
}

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When set, the recipient is fixed and the picker is skipped — the
   * dialog is just a compose box. Used by the contact detail sheet,
   * where the contact is already the subject of the screen.
   */
  fixedContact?: PickerContact;
  /**
   * Called after the message is accepted by the send route, with the
   * contact it went to. The inbox uses it to open the new thread; the
   * contact sheet uses it to offer a link there.
   */
  onSent?: (contactId: string) => void;
}

type Mode = "existing" | "new";

/**
 * Start a conversation with free text — the QR-provider counterpart to
 * the template picker.
 *
 * On Meta a business-initiated message must be an approved template, so
 * callers gate this behind `canStartConversation(capabilities)`. Uazapi
 * and WAHA have no such window and take plain text to any number.
 *
 * Recipient resolution reuses the contacts module's de-dup helpers
 * (`findExistingContact`) rather than inserting blind: typing a number
 * that already exists must reuse that contact, otherwise the unique
 * index from migration 022 rejects the insert and the user gets a raw
 * error for what is really "you already know this person".
 */
export function NewConversationDialog({
  open,
  onOpenChange,
  fixedContact,
  onSent,
}: NewConversationDialogProps) {
  const t = useTranslations("Inbox.newConversation");
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [mode, setMode] = useState<Mode>("existing");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickerContact[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PickerContact | null>(null);
  const [newPhone, setNewPhone] = useState("");
  const [newName, setNewName] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // Reset everything when the dialog closes so the next open starts
  // clean (a half-typed message to the wrong person is a real hazard).
  useEffect(() => {
    if (open) return;
    setMode("existing");
    setQuery("");
    setResults([]);
    setSelected(null);
    setNewPhone("");
    setNewName("");
    setText("");
  }, [open]);

  // Contact search. Debounced so a fast typist doesn't fire a query per
  // keystroke; `ilike` on name or phone matches how users think about
  // finding someone ("maria" or "9982").
  useEffect(() => {
    if (!open || mode !== "existing" || fixedContact) return;
    const q = sanitizeSearchTerm(query);
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void supabase
        .from("contacts")
        .select("id, name, phone")
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .order("name")
        .limit(8)
        .then(({ data }) => {
          if (cancelled) return;
          setResults((data as PickerContact[]) ?? []);
          setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `supabase` is a stable client factory result; re-running on it
    // would refire the search on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, mode, fixedContact]);

  /**
   * Resolve the recipient to a contact id, creating the contact when the
   * user typed a number we don't have yet. Returns null after surfacing
   * its own toast, so the caller just bails.
   */
  async function resolveContactId(): Promise<string | null> {
    if (fixedContact) return fixedContact.id;
    if (mode === "existing") {
      if (!selected) {
        toast.error(t("errorNoRecipient"));
        return null;
      }
      return selected.id;
    }

    const phone = newPhone.trim();
    if (!isValidE164(phone)) {
      toast.error(t("errorInvalidPhone"));
      return null;
    }
    if (!user || !accountId) {
      toast.error(t("errorNoAccount"));
      return null;
    }

    // Reuse over insert — see the component doc.
    const existing = await findExistingContact(supabase, accountId, phone);
    if (existing) return existing.id;

    const { data, error } = await supabase
      .from("contacts")
      .insert({
        user_id: user.id,
        account_id: accountId,
        name: newName.trim() || null,
        phone: normalizePhone(phone),
      })
      .select("id")
      .single();

    if (error || !data) {
      toast.error(t("errorContactCreate"));
      return null;
    }
    return data.id as string;
  }

  async function handleSend() {
    const body = text.trim();
    if (!body) {
      toast.error(t("errorEmptyMessage"));
      return;
    }

    setSending(true);
    try {
      const contactId = await resolveContactId();
      if (!contactId) return;

      // The send route find-or-creates the conversation from contact_id,
      // which is exactly the business-initiated path the template send
      // already uses — no conversation needs to exist beforehand.
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          message_type: "text",
          content_text: body,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Keep the dialog open: the message is still in the box, so the
        // user can fix the number or retry without retyping it.
        toast.error(t("errorSend", { reason: payload?.error ?? `HTTP ${res.status}` }));
        return;
      }

      toast.success(t("toastSent"));
      onOpenChange(false);
      onSent?.(contactId);
    } catch (err) {
      toast.error(
        t("errorSend", {
          reason: err instanceof Error ? err.message : "network error",
        }),
      );
    } finally {
      setSending(false);
    }
  }

  const recipientLabel = fixedContact
    ? fixedContact.name || fixedContact.phone
    : selected
      ? selected.name || selected.phone
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-foreground">
            {fixedContact ? t("titleFixed") : t("title")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {fixedContact
              ? t("descriptionFixed", { name: recipientLabel ?? "" })
              : t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {!fixedContact && (
            <>
              {/* Recipient mode switch */}
              <div className="flex gap-1 rounded-lg bg-muted p-1">
                <button
                  type="button"
                  onClick={() => setMode("existing")}
                  className={
                    mode === "existing"
                      ? "flex-1 rounded-md bg-card px-3 py-1.5 text-sm font-medium text-foreground"
                      : "flex-1 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                  }
                >
                  {t("modeExisting")}
                </button>
                <button
                  type="button"
                  onClick={() => setMode("new")}
                  className={
                    mode === "new"
                      ? "flex-1 rounded-md bg-card px-3 py-1.5 text-sm font-medium text-foreground"
                      : "flex-1 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                  }
                >
                  {t("modeNew")}
                </button>
              </div>

              {mode === "existing" ? (
                selected ? (
                  <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">
                        {selected.name || t("unnamed")}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {selected.phone}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      aria-label={t("clearRecipient")}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t("searchPlaceholder")}
                        className="border-border bg-muted pl-9 text-sm"
                      />
                    </div>
                    {searching && (
                      <p className="px-1 text-xs text-muted-foreground">
                        {t("searching")}
                      </p>
                    )}
                    {!searching && sanitizeSearchTerm(query).length >= 2 && results.length === 0 && (
                      <p className="px-1 text-xs text-muted-foreground">
                        {t("noResults")}
                      </p>
                    )}
                    {results.length > 0 && (
                      <div className="max-h-44 overflow-y-auto rounded-lg border border-border">
                        {results.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setSelected(c)}
                            className="flex w-full flex-col items-start gap-0.5 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted/60"
                          >
                            <span className="truncate text-sm text-foreground">
                              {c.name || t("unnamed")}
                            </span>
                            <span className="truncate font-mono text-xs text-muted-foreground">
                              {c.phone}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="nc-phone" className="text-muted-foreground">
                      {t("phoneLabel")}
                    </Label>
                    <Input
                      id="nc-phone"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      placeholder="5511999998888"
                      inputMode="tel"
                      className="border-border bg-muted font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("phoneHint")}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="nc-name" className="text-muted-foreground">
                      {t("nameLabel")}
                    </Label>
                    <Input
                      id="nc-name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={t("namePlaceholder")}
                      className="border-border bg-muted text-sm"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nc-text" className="text-muted-foreground">
              {t("messageLabel")}
            </Label>
            <Textarea
              id="nc-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("messagePlaceholder")}
              rows={4}
              className="border-border bg-muted text-sm"
            />
          </div>

          {/* Cold-outreach warning — a number that blasts strangers gets
              restricted by WhatsApp, which costs the whole installation. */}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            {t("coldWarning")}
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={sending}
            className="text-muted-foreground hover:text-foreground"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleSend}
            disabled={sending}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : fixedContact || selected ? (
              <Send className="size-4" />
            ) : (
              <UserPlus className="size-4" />
            )}
            {t("send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
