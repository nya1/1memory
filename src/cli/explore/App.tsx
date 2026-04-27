import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { MemoryRecord, ProfileRecord } from "../../core/types.js";
import { decodeListCursor, getMemories, listMemoriesPage, type MemoryCompactView } from "../../memory/memory-service.js";
import type { RecallResult } from "../../recall/recall-service.js";
import { recallMemory } from "../../recall/recall-service.js";
import { EMBEDDING_MODEL_DIR } from "../../embeddings/constants.js";
import {
  getLastEmbeddingInitError,
  getVectorRetrievalReadySync,
  probeVectorRetrievalReady
} from "../../embeddings/embedding-runtime.js";
import { isBundledEmbeddingModelPresent } from "../../embeddings/bundled-paths.js";
import { listProfiles, resolveProfile, selectProfile } from "../../profiles/profile-service.js";
import { theme } from "./theme.js";

const LIST_LIMIT = 16;

const MENU = [
  { id: "browse" as const, label: "Browse memories", hint: "↑↓ pick row · Enter open · n more" },
  { id: "search" as const, label: "Search", hint: "Esc — menu · Tab — query ↔ hits · Enter run" },
  { id: "viewId" as const, label: "View by ID", hint: "Enter after pasting mem_…" },
  { id: "profiles" as const, label: "Switch profile", hint: "↑↓ · Enter apply" },
  { id: "quit" as const, label: "Quit", hint: "q or Enter here" }
];

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function clipPreview(text: string, width: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= width) return one;
  return `${one.slice(0, width - 1)}…`;
}

export interface ExploreAppProps {
  workspaceDir: string;
  initialProfileId: string;
  initialProfileName: string;
}

export function ExploreApp(props: ExploreAppProps): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termRows = stdout.rows ?? 24;
  const termCols = stdout.columns ?? 80;

  const embedSkipped = process.env.JUSTMEMORY_SKIP_EMBEDDINGS === "1";
  const [embedBundledPresent] = useState(() => isBundledEmbeddingModelPresent());
  const [embedPipeline, setEmbedPipeline] = useState<"idle" | "loading" | "ok" | "fail">(() => {
    if (process.env.JUSTMEMORY_SKIP_EMBEDDINGS === "1") return "idle";
    if (!isBundledEmbeddingModelPresent()) return "idle";
    return getVectorRetrievalReadySync() ? "ok" : "loading";
  });

  const [profileId, setProfileId] = useState(props.initialProfileId);
  const [profileName, setProfileName] = useState(props.initialProfileName);
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;

  const [activeProfile, setActiveProfile] = useState<ProfileRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [focus, setFocus] = useState<"sidebar" | "body">("sidebar");

  const [memories, setMemories] = useState<MemoryCompactView[]>([]);
  const [listNextCursor, setListNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [memIndex, setMemIndex] = useState(0);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RecallResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchInputFocused, setSearchInputFocused] = useState(true);
  const [resultIndex, setResultIndex] = useState(0);

  const [viewQuery, setViewQuery] = useState("");
  const [viewBusy, setViewBusy] = useState(false);
  const [viewMessage, setViewMessage] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [profilePickIndex, setProfilePickIndex] = useState(0);
  const [profilesLoading, setProfilesLoading] = useState(false);

  const [detail, setDetail] = useState<MemoryRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await resolveProfile({ profile_id: profileId, workspace: props.workspaceDir });
        if (!cancelled) setActiveProfile(p);
      } catch {
        if (!cancelled) setActiveProfile(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId, props.workspaceDir]);

  useEffect(() => {
    setActionError(null);
  }, [menuIndex]);

  const sidebarWidth = Math.min(28, Math.max(22, Math.floor(termCols * 0.32)));
  const contentWidth = Math.max(40, termCols - sidebarWidth - 4);
  const listViewport = Math.max(6, Math.min(LIST_LIMIT, termRows - 14));

  useEffect(() => {
    if (menuIndex !== 0) return;
    let cancelled = false;
    const pid = profileId;
    void (async () => {
      setListLoading(true);
      try {
        const page = await listMemoriesPage(pid, {
          limit: LIST_LIMIT,
          offset: 0,
          label: undefined,
          namespace: undefined,
          memory_type: undefined,
          status: undefined
        });
        if (cancelled || profileIdRef.current !== pid) return;
        setMemories(page.records);
        setListNextCursor(page.next_cursor);
        setMemIndex(0);
        setActionError(null);
      } catch (e) {
        if (!cancelled && profileIdRef.current === pid) {
          setActionError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled && profileIdRef.current === pid) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId, menuIndex]);

  useEffect(() => {
    setMemIndex((i) => (memories.length === 0 ? 0 : Math.min(i, memories.length - 1)));
  }, [memories.length]);

  useEffect(() => {
    if (embedSkipped || !embedBundledPresent) return;
    if (getVectorRetrievalReadySync()) {
      setEmbedPipeline("ok");
      return;
    }
    setEmbedPipeline("loading");
    let cancelled = false;
    void probeVectorRetrievalReady().then((ok) => {
      if (cancelled) return;
      setEmbedPipeline(ok ? "ok" : "fail");
    });
    return () => {
      cancelled = true;
    };
  }, [embedSkipped, embedBundledPresent]);

  useEffect(() => {
    if (menuIndex !== 3) return;
    let cancelled = false;
    void (async () => {
      setProfilesLoading(true);
      try {
        const list = await listProfiles();
        if (cancelled) return;
        setProfiles(list);
        const i = list.findIndex((p) => p.profile_id === profileId);
        setProfilePickIndex(i >= 0 ? i : 0);
        setActionError(null);
      } catch (e) {
        if (!cancelled) setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setProfilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [menuIndex, profileId]);

  const appendNextPage = useCallback(async () => {
    if (!listNextCursor) return;
    const pid = profileIdRef.current;
    const cursor = listNextCursor;
    setListLoading(true);
    try {
      const page = await listMemoriesPage(pid, {
        limit: LIST_LIMIT,
        offset: decodeListCursor(cursor),
        label: undefined,
        namespace: undefined,
        memory_type: undefined,
        status: undefined
      });
      if (profileIdRef.current !== pid) return;
      setMemories((prev) => [...prev, ...page.records]);
      setListNextCursor(page.next_cursor);
      setActionError(null);
    } catch (e) {
      if (profileIdRef.current === pid) {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (profileIdRef.current === pid) setListLoading(false);
    }
  }, [listNextCursor]);

  const openMemoryDetail = useCallback(async (memoryId: string) => {
    try {
      const [rec] = await getMemories([memoryId]);
      setDetail(rec);
      setActionError(null);
    } catch {
      setActionError(`Could not open memory: ${memoryId} (not found or inaccessible).`);
    }
  }, []);

  const runSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    const pid = profileIdRef.current;
    setSearchLoading(true);
    setSearchResults(null);
    try {
      const profile =
        activeProfile?.profile_id === pid
          ? activeProfile
          : await resolveProfile({ profile_id: pid, workspace: props.workspaceDir });
      if (profileIdRef.current !== pid) return;
      const result = await recallMemory(profile, q, 14);
      if (profileIdRef.current !== pid) return;
      setSearchResults(result);
      setResultIndex(0);
      setSearchInputFocused(false);
      setActionError(null);
    } catch (e) {
      if (profileIdRef.current === pid) {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (profileIdRef.current === pid) setSearchLoading(false);
    }
  }, [activeProfile, props.workspaceDir, searchQuery]);

  const applyProfile = useCallback(async () => {
    const p = profiles[profilePickIndex];
    if (!p) return;
    try {
      await selectProfile({ profile_id: p.profile_id, workspace: props.workspaceDir });
      setProfileId(p.profile_id);
      setProfileName(p.name);
      setMenuIndex(0);
      setFocus("sidebar");
      setActionError(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }, [profiles, profilePickIndex, props.workspaceDir]);

  const textInputStealsKeys =
    (menuIndex === 1 && focus === "body" && searchInputFocused) || (menuIndex === 2 && focus === "body");

  /** Escape / Tab while TextInput owns keys; Escape+q when detail opened from View by ID (sidebar keys off). */
  useInput(
    (input, key) => {
      if (detail) {
        if (key.escape || input === "q") setDetail(null);
        return;
      }
      if (textInputStealsKeys) {
        if (key.escape) {
          setFocus("sidebar");
          setSearchInputFocused(true);
          setActionError(null);
          return;
        }
        if (
          key.tab &&
          menuIndex === 1 &&
          focus === "body" &&
          searchResults &&
          searchResults.citations.length > 0
        ) {
          setSearchInputFocused((f) => !f);
        }
      }
    },
    { isActive: Boolean(detail) || textInputStealsKeys }
  );

  useInput(
    (input, key) => {
      if (detail) {
        if (key.escape || input === "q") setDetail(null);
        return;
      }

      if (input === "q" && !textInputStealsKeys) {
        exit();
        return;
      }

      if (key.escape) {
        if (focus === "body") {
          setFocus("sidebar");
          setSearchInputFocused(true);
          setActionError(null);
        }
        return;
      }

      if (key.tab) {
        if (menuIndex === 1 && focus === "body" && searchResults && searchResults.citations.length > 0) {
          setSearchInputFocused((f) => !f);
        } else if (focus === "sidebar") {
          setFocus("body");
          if (menuIndex === 1) setSearchInputFocused(true);
        } else {
          setFocus("sidebar");
        }
        return;
      }

      if (key.leftArrow && focus === "body" && !textInputStealsKeys) {
        setFocus("sidebar");
        return;
      }

      if (key.rightArrow && focus === "sidebar") {
        setFocus("body");
        if (menuIndex === 1) setSearchInputFocused(true);
        return;
      }

      if (focus === "sidebar") {
        if (key.upArrow) {
          setMenuIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setMenuIndex((i) => Math.min(MENU.length - 1, i + 1));
          return;
        }
        if (key.return) {
          const m = MENU[menuIndex];
          if (m.id === "quit") {
            exit();
            return;
          }
          setFocus("body");
          if (menuIndex === 1) {
            setSearchInputFocused(true);
          }
          if (menuIndex === 2) {
            setViewQuery("");
            setViewMessage(null);
          }
        }
        return;
      }

      // body focus
      const section = MENU[menuIndex]?.id;
      if (section === "browse") {
        if (key.upArrow) {
          setMemIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setMemIndex((i) => Math.min(Math.max(0, memories.length - 1), i + 1));
          return;
        }
        if (input === "n" && listNextCursor) {
          void appendNextPage();
          return;
        }
        if (key.return && memories[memIndex]) {
          void openMemoryDetail(memories[memIndex]!.memory_id);
        }
        return;
      }

      if (section === "search") {
        if (searchInputFocused) return;
        const cites = searchResults?.citations ?? [];
        if (cites.length === 0) return;
        if (key.upArrow) {
          setResultIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setResultIndex((i) => Math.min(cites.length - 1, i + 1));
          return;
        }
        if (key.return && cites[resultIndex]) {
          void openMemoryDetail(cites[resultIndex]!.memory_id);
        }
        return;
      }

      if (section === "viewId") {
        return;
      }

      if (section === "profiles") {
        if (profiles.length === 0) return;
        if (key.upArrow) {
          setProfilePickIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setProfilePickIndex((i) => Math.min(profiles.length - 1, i + 1));
          return;
        }
        if (key.return) {
          void applyProfile();
        }
      }
    },
    {
      isActive: !textInputStealsKeys
    }
  );

  const windowStart = useMemo(() => {
    if (memories.length === 0) return 0;
    const half = Math.floor(listViewport / 2);
    const maxStart = Math.max(0, memories.length - listViewport);
    return Math.max(0, Math.min(memIndex - half, maxStart));
  }, [memIndex, memories.length, listViewport]);

  const visibleMemories = useMemo(
    () => memories.slice(windowStart, windowStart + listViewport),
    [memories, windowStart, listViewport]
  );

  const searchCitations = searchResults?.citations ?? [];
  const citeWindowStart = useMemo(() => {
    if (searchCitations.length === 0) return 0;
    const maxStart = Math.max(0, searchCitations.length - listViewport);
    return Math.max(0, Math.min(resultIndex - 2, maxStart));
  }, [searchCitations.length, resultIndex, listViewport]);
  const visibleCitations = useMemo(
    () => searchCitations.slice(citeWindowStart, citeWindowStart + listViewport),
    [searchCitations, citeWindowStart, listViewport]
  );

  const embedStatusLine = embedSkipped ? (
    <Text color={theme.warn}>Local embedding model: skipped (JUSTMEMORY_SKIP_EMBEDDINGS=1)</Text>
  ) : embedBundledPresent ? (
    <Box flexDirection="column">
      <Text color={theme.ok}>
        Local embedding model: {EMBEDDING_MODEL_DIR}
      </Text>
      <Text dimColor color={theme.subtitle}>
        {embedPipeline === "loading" ? "Verifying ONNX pipeline…" : ""}
        {embedPipeline === "ok" ? "Vector search: ready" : ""}
        {embedPipeline === "fail"
          ? `Vector search: unavailable — ${truncate(getLastEmbeddingInitError() ?? "unknown error", Math.max(24, termCols - 28))}`
          : ""}
      </Text>
    </Box>
  ) : (
    <Text dimColor color={theme.warn}>
      Local embedding model: not installed (missing models/{EMBEDDING_MODEL_DIR}/…)
    </Text>
  );

  const header = (
    <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1} flexDirection="column">
      <Text bold color={theme.title}>
        JustMemory
      </Text>
      {embedStatusLine}
      <Text dimColor color={theme.subtitle}>
        {profileName} · {truncate(profileId, Math.max(20, termCols - 24))}
      </Text>
      <Text dimColor color={theme.subtitle}>
        {truncate(props.workspaceDir, termCols - 6)}
      </Text>
    </Box>
  );

  const errorBanner = actionError ? (
    <Box borderStyle="round" borderColor={theme.error} paddingX={1} marginBottom={1}>
      <Text color={theme.error}>{truncate(actionError, Math.max(20, termCols - 4))}</Text>
    </Box>
  ) : null;

  const sidebar = (
    <Box
      width={sidebarWidth}
      borderStyle="round"
      borderColor={focus === "sidebar" ? theme.border : theme.borderMuted}
      paddingX={1}
      flexDirection="column"
    >
      <Text bold color={theme.accent}>
        Menu
      </Text>
      <Box marginY={1} flexDirection="column">
        {MENU.map((m, i) => {
          const sel = i === menuIndex && focus === "sidebar";
          return (
            <Box key={m.id} minHeight={1}>
              <Text inverse={sel} bold={sel} color={sel ? undefined : theme.body}>
                {sel ? ` ▸ ${m.label}` : `   ${m.label}`}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{MENU[menuIndex]?.hint}</Text>
      </Box>
    </Box>
  );

  let body: ReactNode = null;
  const active = MENU[menuIndex]?.id;

  if (active === "browse") {
    body = (
      <Box
        flexGrow={1}
        borderStyle="round"
        borderColor={focus === "body" ? theme.border : theme.borderMuted}
        paddingX={1}
        flexDirection="column"
      >
        <Text bold color={theme.title}>
          Memories {listLoading ? "…" : `(${memories.length})`}
        </Text>
        {memories.length === 0 && !listLoading ? (
          <Text dimColor>No memories in this profile.</Text>
        ) : (
          <Box marginTop={1} flexDirection="column">
            {visibleMemories.map((row, j) => {
              const idx = windowStart + j;
              const picked = idx === memIndex && focus === "body";
              const line = `${row.memory_type[0] ?? "?"} ${row.memory_id}  ${clipPreview(row.content_preview, contentWidth - 18)}`;
              return (
                <Text key={row.memory_id} inverse={picked} dimColor={!picked && row.status !== "active"}>
                  {line}
                </Text>
              );
            })}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>
            {listNextCursor ? "n — load more rows · " : ""}
            Enter — full view · Esc — back to menu
          </Text>
        </Box>
      </Box>
    );
  } else if (active === "search") {
    body = (
      <Box
        flexGrow={1}
        borderStyle="round"
        borderColor={focus === "body" ? theme.border : theme.borderMuted}
        paddingX={1}
        flexDirection="column"
      >
        <Text bold color={theme.title}>
          Search
        </Text>
        <Box marginY={1}>
          <Text dimColor>Query: </Text>
          <TextInput
            value={searchQuery}
            onChange={setSearchQuery}
            onSubmit={() => void runSearch()}
            placeholder="keywords, topic, paste text…"
            focus={focus === "body" && searchInputFocused}
            showCursor
          />
        </Box>
        {searchLoading ? (
          <Text color={theme.warn}>Searching…</Text>
        ) : searchResults ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              {searchResults.citations.length} hit(s) · Tab — edit query vs browse hits · channels:{" "}
              {searchResults.retrieval_channels_used.join(", ")}
            </Text>
            <Box marginTop={1} flexDirection="column">
              {visibleCitations.map((c, j) => {
                const i = citeWindowStart + j;
                const picked = i === resultIndex && !searchInputFocused && focus === "body";
                const preview = clipPreview(c.content, contentWidth - 6);
                return (
                  <Text key={c.memory_id} inverse={picked}>
                    {c.memory_id} [{c.memory_type}] {preview}
                  </Text>
                );
              })}
            </Box>
          </Box>
        ) : (
          <Text dimColor>Enter runs recall (lexical + vector when available).</Text>
        )}
      </Box>
    );
  } else if (active === "viewId") {
    body = (
      <Box
        flexGrow={1}
        borderStyle="round"
        borderColor={focus === "body" ? theme.border : theme.borderMuted}
        paddingX={1}
        flexDirection="column"
      >
        <Text bold color={theme.title}>
          View by ID
        </Text>
        <Box marginY={1}>
          <Text dimColor>memory_id: </Text>
          <TextInput
            value={viewQuery}
            onChange={setViewQuery}
            onSubmit={() => {
              const id = viewQuery.trim();
              if (!id) return;
              void (async () => {
                setViewBusy(true);
                setViewMessage(null);
                try {
                  const [rec] = await getMemories([id]);
                  setDetail(rec);
                  setActionError(null);
                } catch (e) {
                  setViewMessage(e instanceof Error ? e.message : "Not found.");
                } finally {
                  setViewBusy(false);
                }
              })();
            }}
            placeholder="mem_…"
            focus={focus === "body"}
            showCursor
          />
        </Box>
        {viewBusy ? <Text color={theme.warn}>Loading…</Text> : null}
        {viewMessage ? <Text color={theme.error}>{viewMessage}</Text> : null}
        <Text dimColor>Enter — fetch · Esc — menu</Text>
      </Box>
    );
  } else if (active === "profiles") {
    body = (
      <Box
        flexGrow={1}
        borderStyle="round"
        borderColor={focus === "body" ? theme.border : theme.borderMuted}
        paddingX={1}
        flexDirection="column"
      >
        <Text bold color={theme.title}>
          Profiles
        </Text>
        {profilesLoading ? (
          <Text dimColor>Loading…</Text>
        ) : (
          <Box marginTop={1} flexDirection="column">
            {profiles.map((p, i) => {
              const picked = i === profilePickIndex && focus === "body";
              return (
                <Text key={p.profile_id} inverse={picked}>
                  {p.name} · {truncate(p.profile_id, contentWidth - 20)}
                </Text>
              );
            })}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter — set active for this workspace</Text>
        </Box>
      </Box>
    );
  } else if (active === "quit") {
    body = (
      <Box flexGrow={1} borderStyle="round" borderColor={theme.borderMuted} paddingX={1} justifyContent="center">
        <Text dimColor>Press Enter on Quit in the menu, or q to exit.</Text>
      </Box>
    );
  }

  const footer = (
    <Box marginTop={1} borderStyle="single" borderTop borderColor={theme.borderMuted} paddingTop={1}>
      <Text dimColor>
        Tab — sidebar ↔ panel (search: query ↔ hits) · ← → — sidebar / panel · Esc — menu · q — quit
      </Text>
    </Box>
  );

  const detailPane = detail ? (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.accent}
      paddingX={1}
      paddingY={1}
      marginTop={1}
      width={termCols - 2}
    >
      <Text bold color={theme.title}>
        {detail.memory_id}
      </Text>
      <Text dimColor>
        {detail.memory_type} · {detail.status} · ns:{detail.namespace}
      </Text>
      <Box marginY={1} flexDirection="column">
        <Text wrap="wrap">{detail.content}</Text>
      </Box>
      {detail.labels.length > 0 ? <Text dimColor>labels: {detail.labels.join(", ")}</Text> : null}
      <Text dimColor>updated {detail.updated_at}</Text>
      <Box marginTop={1}>
        <Text color={theme.ok}>Esc or q — close</Text>
      </Box>
    </Box>
  ) : null;

  return (
    <Box flexDirection="column" width={termCols}>
      {!detail ? (
        <>
          {header}
          {errorBanner}
          <Box flexDirection="row">
            {sidebar}
            <Box marginLeft={1} flexGrow={1} flexDirection="column" minWidth={0}>
              {body}
            </Box>
          </Box>
          {footer}
        </>
      ) : (
        detailPane
      )}
    </Box>
  );
}
