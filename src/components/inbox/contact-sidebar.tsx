"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type {
  Contact,
  Deal,
  ContactNote,
  Tag,
  Pipeline,
  PipelineStage,
} from "@/types";
import { toast } from "sonner";
import { groupStagesByPipeline } from "@/lib/pipelines/stage-groups";
import {
  DealStageSelect,
  AddToPipelineMenu,
} from "@/components/inbox/deal-pipeline-controls";
import { ContactEditDialog } from "@/components/contacts/contact-edit-dialog";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { useTranslations } from "next-intl";

interface ContactSidebarProps {
  contact: Contact | null;
  /**
   * Open conversation in the Inbox — linked to deals created from here.
   * Optional: without it the deal is born unlinked instead of failing.
   */
  conversationId?: string;
  /**
   * Contato relido depois de editado aqui — a página propaga para o
   * cabeçalho da conversa e para a lista.
   */
  onContactSaved?: (contact: Contact) => void;
}

export function ContactSidebar({
  contact,
  conversationId,
  onContactSaved,
}: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId, isViewer, defaultCurrency } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [creatingDeal, setCreatingDeal] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, tags, pipelines and stages in parallel.
    // pipelines/pipeline_stages go unfiltered by account — same pattern
    // as pipelines/page.tsx:76-95, where RLS is the boundary.
    const [dealsRes, notesRes, tagsRes, pipelinesRes, stagesRes] =
      await Promise.all([
        supabase
          .from("deals")
          .select("*, stage:pipeline_stages(*)")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_notes")
          .select("*")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_tags")
          .select("id, tag_id, tags(*)")
          .eq("contact_id", contact.id),
        supabase.from("pipelines").select("*").order("created_at"),
        supabase.from("pipeline_stages").select("*").order("position"),
      ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (pipelinesRes.data) setPipelines(pipelinesRes.data);
    if (stagesRes.data) setStages(stagesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  const stageGroups = groupStagesByPipeline(pipelines, stages);

  // Optimistic update, same move the board does
  // (pipelines/page.tsx:224): flip it now, roll back with a toast if the
  // write fails. RLS (agent role minimum, migration 017) is the real gate.
  const handleMoveDeal = useCallback(
    async (deal: Deal, stage: PipelineStage) => {
      const previous = deals;
      setDeals((current) =>
        current.map((d) =>
          d.id === deal.id ? { ...d, stage_id: stage.id, stage } : d,
        ),
      );

      const supabase = createClient();
      const { error } = await supabase
        .from("deals")
        .update({ stage_id: stage.id })
        .eq("id", deal.id);

      if (error) {
        setDeals(previous);
        toast.error(tSidebar("toastMoveFailed"));
      }
    },
    [deals, tSidebar],
  );

  // Insert mirrors deal-form.tsx:200 — user_id is NOT NULL since
  // migration 001, and status uses the form's "open" literal (the column
  // DEFAULT is 'active', a divergence inherited from upstream).
  const handleAddToPipeline = useCallback(
    async (pipelineId: string, stage: PipelineStage) => {
      if (!contact || !accountId) return;
      setCreatingDeal(true);

      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        setCreatingDeal(false);
        return;
      }

      const { data, error } = await supabase
        .from("deals")
        .insert({
          pipeline_id: pipelineId,
          stage_id: stage.id,
          contact_id: contact.id,
          conversation_id: conversationId ?? null,
          title: contact.name || contact.phone,
          value: 0,
          currency: defaultCurrency,
          status: "open",
          user_id: user.id,
          account_id: accountId,
        })
        .select("*, stage:pipeline_stages(*)")
        .single();

      if (error || !data) {
        toast.error(tSidebar("toastCreateFailed"));
      } else {
        setDeals((previous) => [data, ...previous]);
      }
      setCreatingDeal(false);
    },
    [contact, accountId, conversationId, defaultCurrency, tSidebar],
  );

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <div className="mt-3 flex items-center gap-1.5">
              <h3 className="text-sm font-semibold text-foreground">
                {displayName}
              </h3>
              {!isViewer && (
                <button
                  type="button"
                  onClick={() => setEditOpen(true)}
                  aria-label={tSidebar("editContact")}
                  title={tSidebar("editContact")}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="size-3.5" />
                </button>
              )}
            </div>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              {tSidebar("tags")}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              {tSidebar("deals")}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage &&
                        (isViewer ? (
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[10px]"
                            style={{
                              backgroundColor: `${deal.stage.color}20`,
                              color: deal.stage.color,
                            }}
                          >
                            {deal.stage.name}
                          </span>
                        ) : (
                          <DealStageSelect
                            deal={deal}
                            stages={
                              stageGroups.find(
                                (g) => g.pipeline.id === deal.pipeline_id,
                              )?.stages ?? []
                            }
                            onSelect={(stage) => handleMoveDeal(deal, stage)}
                          />
                        ))}
                    </div>
                  </div>
                ))
              )}
            </div>
            {!isViewer && (
              <AddToPipelineMenu
                groups={stageGroups}
                disabled={creatingDeal}
                onSelect={handleAddToPipeline}
              />
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>

      <ContactEditDialog
        contactId={contact.id}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={(updated) => {
          setEditOpen(false);
          onContactSaved?.(updated);
        }}
      />
    </div>
  );
}
