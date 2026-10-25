"use client";

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  Compass,
  Leaf,
  LockKeyhole,
  MapPin,
  Menu,
  MessageCircle,
  Minus,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  LogOut,
  LayoutDashboard,
  CircleHelp,
} from "lucide-react";
import {
  destinations,
  destinationById,
  interests,
  type Destination,
  type TravelPackage,
} from "@/lib/catalog";
import {
  dateForDay,
  duration,
  money,
  type Preferences,
} from "@/lib/validation";
import type { Booking, Enquiry, Plan, User } from "@/lib/db";
import { googleErrors } from "@/lib/google-messages";

type View =
  | "home"
  | "destinations"
  | "journeys"
  | "planner"
  | "trips"
  | "contact"
  | "agency";
type Session = {
  user: User | null;
  aiReady: boolean;
  paymentReady: boolean;
  googleReady: boolean;
  googleLinked: boolean;
};
type TripData = { plans: Plan[]; bookings: Booking[]; enquiries: Enquiry[] };
type AdminData = TripData & { packages: TravelPackage[] };
type Chat = { role: "assistant" | "user"; text: string };
const emptyTrips: TripData = { plans: [], bookings: [], enquiries: [] };
const navItems: { id: View; label: string }[] = [
  { id: "destinations", label: "Destinations" },
  { id: "journeys", label: "Our journeys" },
  { id: "planner", label: "Build your trip" },
];
const tomorrow = () => dateForDay(new Date().toISOString().slice(0, 10), 30);
const initialPreferences = (): Preferences => ({
  startDate: tomorrow(),
  endDate: dateForDay(tomorrow(), 5),
  partySize: 2,
  budget: 4000,
  currency: "USD",
  interests: ["Wildlife", "Nature"],
});
async function api<T>(path: string, data?: object): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: data ? "POST" : "GET",
    headers: data ? { "Content-Type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "The request could not be completed.");
  return result as T;
}

export default function TravelApp({
  initialPackages,
}: {
  initialPackages: TravelPackage[];
}) {
  const [view, setView] = useState<View>("home");
  const [session, setSession] = useState<Session>({
    user: null,
    aiReady: false,
    paymentReady: false,
    googleReady: false,
    googleLinked: false,
  });
  const [ready, setReady] = useState(false);
  const [catalog, setCatalog] = useState(initialPackages);
  const [trips, setTrips] = useState<TripData>(emptyTrips);
  const [admin, setAdmin] = useState<AdminData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [auth, setAuth] = useState<"login" | "register" | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [preferences, setPreferences] =
    useState<Preferences>(initialPreferences);
  const [selectedPackage, setSelectedPackage] = useState(
    initialPackages[0]?.id || "",
  );
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [plannerMode, setPlannerMode] = useState<"curated" | "ai">("curated");
  const [chat, setChat] = useState<Chat[]>([
    {
      role: "assistant",
      text: "Karibu! Tell me what your ideal Kenya trip feels like. When AI is connected, I can look up our curated catalog and help shape a day-by-day plan. Our team confirms every quote before checkout.",
    },
  ]);
  const [prompt, setPrompt] = useState("");
  const [filter, setFilter] = useState("All experiences");
  const closeAuth = useCallback(() => setAuth(null), []);
  const closeDestination = useCallback(() => setDestination(null), []);

  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash.slice(1);
      if (
        [
          "home",
          "destinations",
          "journeys",
          "planner",
          "trips",
          "contact",
          "agency",
        ].includes(hash)
      )
        setView(hash as View);
    };
    sync();
    window.addEventListener("hashchange", sync);
    api<Session>("session")
      .then(async (s) => {
        setSession(s);
        if (s.user) setTrips(await api<TripData>("trips"));
        if (new URLSearchParams(window.location.search).has("checkout"))
          setNotice(
            "Checkout returned. Only a verified provider webhook updates your booking to paid. Refresh your trips to check its status.",
          );
        const params = new URLSearchParams(window.location.search);
        const googleError = params.get("googleError");
        if (googleError) {
          setError(
            Object.prototype.hasOwnProperty.call(googleErrors, googleError)
              ? googleErrors[googleError as keyof typeof googleErrors]
              : googleErrors.failed,
          );
        } else if (
          s.user &&
          ["linked", "signed-in"].includes(params.get("google") || "")
        ) {
          setNotice(
            params.get("google") === "linked"
              ? "Google is now connected to your existing account. Your saved trips and agency access are unchanged."
              : `You're signed in with Google as ${s.user.name}.`,
          );
        }
        if (params.has("google") || params.has("googleError")) {
          params.delete("google");
          params.delete("googleError");
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`,
          );
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setReady(true));
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function go(next: View) {
    setView(next);
    setMobileMenu(false);
    setError("");
    setNotice("");
    window.history.pushState(null, "", `#${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Something went wrong. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  function signedIn() {
    if (!session.user) {
      setAuth("register");
      return false;
    }
    return true;
  }
  async function refresh() {
    setTrips(await api<TripData>("trips"));
  }
  async function startGoogle(intent: "signin" | "link", password?: string) {
    await run(async () => {
      const result = await api<{ url: string }>("auth/google/start", {
        intent,
        returnSection: intent === "link" ? "trips" : view,
        ...(password ? { password } : {}),
      });
      const target = new URL(result.url);
      if (
        target.protocol !== "https:" ||
        target.hostname !== "accounts.google.com"
      )
        throw new Error(
          "Unexpected Google sign-in destination. Please contact the agency.",
        );
      window.location.assign(target.href);
    });
  }
  async function openAgency() {
    go("agency");
    await run(async () => setAdmin(await api<AdminData>("admin/overview")));
  }
  function choosePackage(item: TravelPackage) {
    setSelectedPackage(item.id);
    setPlannerMode("curated");
    setPreferences((p) => ({
      ...p,
      endDate: p.startDate ? dateForDay(p.startDate, item.days - 1) : p.endDate,
    }));
    go("planner");
  }
  async function saveCurated(event: FormEvent) {
    event.preventDefault();
    if (!signedIn()) return;
    await run(async () => {
      const result = await api<{ plan: Plan }>("plans/catalog", {
        packageId: selectedPackage,
        preferences,
      });
      setActivePlan(result.plan);
      await refresh();
      setNotice(
        "Your curated itinerary is saved. Review the estimate, then request an agency quote.",
      );
    });
  }
  async function generate(mode: "plan" | "enquiry") {
    if (!signedIn()) return;
    const text =
      prompt.trim() ||
      (mode === "plan"
        ? "Create a thoughtful Kenya trip matching my preferences."
        : "");
    if (!text) {
      setError("Tell the assistant what you would like to know.");
      return;
    }
    await run(async () => {
      const result = await api<{ plan?: Plan; answer?: string }>("ai", {
        mode,
        message: text,
        preferences,
        previousPlanId: activePlan?.id,
      });
      setChat((c) => [
        ...c,
        { role: "user", text },
        {
          role: "assistant",
          text:
            result.answer ||
            "Your itinerary is ready and saved. Its estimate is calculated from our illustrative catalog, not live supplier pricing.",
        },
      ]);
      setPrompt("");
      if (result.plan) {
        setActivePlan(result.plan);
        await refresh();
      }
    });
  }
  async function booking(planId: string) {
    await run(async () => {
      await api("bookings", { planId });
      await refresh();
      setNotice(
        "Request sent. The agency will review availability and issue a detailed quote before any payment.",
      );
    });
  }
  async function checkout(bookingId: string) {
    await run(async () => {
      const result = await api<{ url: string }>("checkout", { bookingId });
      await refresh();
      const target = new URL(result.url);
      if (
        target.protocol !== "https:" ||
        target.hostname !== "checkout.stripe.com"
      )
        throw new Error("Unexpected checkout destination. Contact the agency.");
      window.location.assign(target.href);
    });
  }

  const stepLabels = [
    "Make it yours",
    "Meet your itinerary",
    "Let us take care of it",
  ];
  return (
    <div className="app-shell">
      <div className="announcement">
        <Leaf size={12} /> A little closer to nature. A little closer to Kenya.{" "}
        <span>Thoughtfully planned, locally inspired.</span>
      </div>
      <header className="header">
        <a
          className="brand"
          href="#home"
          onClick={(e) => {
            e.preventDefault();
            go("home");
          }}
          aria-label="Sanaa Kenya home"
        >
          <span className="brand-icon">
            <Compass size={28} strokeWidth={1.3} />
          </span>
          <span>
            sanaa<span className="brand-country">KENYA</span>
          </span>
          <span className="brand-dot">.</span>
        </a>
        <nav
          className={mobileMenu ? "main-nav mobile-open" : "main-nav"}
          aria-label="Main navigation"
        >
          {navItems.map((n) => (
            <a
              key={n.id}
              href={`#${n.id}`}
              className={view === n.id ? "nav-active" : ""}
              onClick={(e) => {
                e.preventDefault();
                go(n.id);
              }}
            >
              {n.label}
              {n.id === "planner" && <Sparkles size={12} />}
            </a>
          ))}
          <a
            href="#contact"
            onClick={(e) => {
              e.preventDefault();
              go("contact");
            }}
          >
            Our approach
          </a>
        </nav>
        <div className="header-actions">
          {session.user ? (
            <>
              <button
                className="text-button account-name"
                onClick={() => go("trips")}
              >
                My trips
              </button>
              {session.user.role === "admin" && (
                <button
                  className="icon-button"
                  title="Agency dashboard"
                  aria-label="Agency dashboard"
                  onClick={openAgency}
                >
                  <LayoutDashboard size={19} />
                </button>
              )}
              <button
                className="icon-button"
                title="Sign out"
                aria-label="Sign out"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api("auth/logout", {});
                    setSession((s) => ({
                      ...s,
                      user: null,
                      googleLinked: false,
                    }));
                    setTrips(emptyTrips);
                    setAdmin(null);
                    setActivePlan(null);
                    go("home");
                  })
                }
              >
                <LogOut size={17} />
              </button>
            </>
          ) : (
            <button
              className="text-button account-name"
              onClick={() => setAuth("login")}
            >
              Sign in
            </button>
          )}
          <button
            className="button button-small header-cta"
            onClick={() => go("planner")}
          >
            Plan my trip <ArrowUpRight size={15} />
          </button>
          <button
            className="icon-button mobile-toggle"
            aria-label="Toggle navigation"
            aria-expanded={mobileMenu}
            onClick={() => setMobileMenu(!mobileMenu)}
          >
            <Menu />
          </button>
        </div>
      </header>
      {(error || notice) && (
        <div
          className={`global-message ${error ? "error" : "success"}`}
          role={error ? "alert" : "status"}
        >
          <span>{error || notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss message"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            <X size={17} />
          </button>
        </div>
      )}
      <main>
        {view === "home" && (
          <>
            <section className="hero">
              <div className="hero-overlay" />
              <div className="hero-content">
                <div className="eyebrow light">
                  <span className="tiny-line" /> NOT JUST A PLACE. A FEELING.
                </div>
                <h1>
                  Some journeys
                  <br />
                  stay with you.
                  <br />
                  <em>This is Kenya.</em>
                </h1>
                <p>
                  Wild horizons. Warm welcomes. Your own kind of adventure.
                  <br className="desktop-only" /> Let&apos;s create a journey
                  that feels like you.
                </p>
                <div className="hero-buttons">
                  <button
                    className="button button-cream"
                    onClick={() => go("planner")}
                  >
                    Find my Kenya <ArrowUpRight size={18} />
                  </button>
                  <button className="hero-link" onClick={() => go("journeys")}>
                    Explore our journeys <ArrowRight size={17} />
                  </button>
                </div>
                <div className="hero-proof">
                  <span className="proof-avatars">
                    <span>W</span>
                    <span>K</span>
                    <span>J</span>
                  </span>
                  <span>
                    Big on the details.
                    <br />
                    <strong>Personal from the first hello.</strong>
                  </span>
                </div>
              </div>
              <div className="hero-location">
                <MapPin size={16} />
                <div>
                  Maasai Mara, Kenya<span>1.4061° S · 35.0010° E</span>
                </div>
                <span className="image-caption">
                  Illustrative destination photography
                </span>
              </div>
              <div className="hero-side">LET YOUR CURIOSITY LEAD THE WAY</div>
              <div className="hero-bottom-mark">
                01 <span /> 03
              </div>
            </section>
            <section className="trust-strip">
              <span>
                <Compass size={20} /> One country. Endless possibilities.
              </span>
              <span>
                <Users size={20} /> Your pace, your people, your plan
              </span>
              <span>
                <ShieldCheck size={20} /> A real team behind every journey
              </span>
            </section>
            <section className="section destinations-section">
              <div className="section-top">
                <div>
                  <div className="eyebrow">A PLACE FOR EVERY PART OF YOU</div>
                  <h2>Where will Kenya take you?</h2>
                </div>
                <button
                  className="underlined-link"
                  onClick={() => go("destinations")}
                >
                  Explore destinations <ArrowUpRight size={17} />
                </button>
              </div>
              <p className="section-description">
                From the hush of the savannah to the rhythm of the coast. Follow
                what moves you.
              </p>
              <div className="destination-grid">
                {destinations.slice(0, 3).map((d, i) => (
                  <DestinationCard
                    key={d.id}
                    item={d}
                    index={i}
                    onOpen={() => setDestination(d)}
                  />
                ))}
              </div>
            </section>
            <section className="planner-promo section">
              <div className="promo-copy">
                <div className="eyebrow">
                  <Sparkles size={14} /> A LITTLE TECHNOLOGY. A LOT OF YOU.
                </div>
                <h2>
                  Your dream trip,
                  <br />
                  <em>taking shape.</em>
                </h2>
                <p>
                  Love wildlife but want a few slow mornings? Travelling with
                  little explorers? Share what matters, and shape your own Kenya
                  story.
                </p>
                <button className="button" onClick={() => go("planner")}>
                  Let&apos;s dream it up <ArrowUpRight size={17} />
                </button>
                <span className="subtle-note">
                  AI-assisted ideas. Human-confirmed journeys.
                </span>
              </div>
              <div className="sample-chat">
                <div className="sample-chat-top">
                  <span className="sparkle-disc">
                    <Sparkles size={20} />
                  </span>
                  <div>
                    Your Kenya, your way
                    <small>A peek at the planning experience</small>
                  </div>
                  <span className="sample-label">EXAMPLE</span>
                </div>
                <div className="sample-user">
                  A little safari, a little adventure. 6 days, just the two of
                  us.
                </div>
                <div className="sample-assistant">
                  A lakeside pause and wide-open Mara skies could be just your
                  thing.
                </div>
                <div className="mini-itinerary">
                  <span>
                    <span className="timeline-dot" /> DAYS 1–3{" "}
                    <strong>Nairobi & Lake Naivasha</strong>
                  </span>
                  <span>
                    <span className="timeline-dot" /> DAYS 4–6{" "}
                    <strong>The magic of Maasai Mara</strong>
                  </span>
                </div>
                <div className="sample-footer">
                  <LockKeyhole size={13} /> Illustrative conversation, not a
                  generated itinerary
                </div>
              </div>
            </section>
            <section className="section journey-section">
              <div className="section-top">
                <div>
                  <div className="eyebrow">GOOD PLACES TO BEGIN</div>
                  <h2>A few journeys we love.</h2>
                </div>
                <button
                  className="underlined-link"
                  onClick={() => go("journeys")}
                >
                  All curated journeys <ArrowUpRight size={17} />
                </button>
              </div>
              <div className="package-grid">
                {catalog.slice(0, 3).map((p) => (
                  <PackageCard
                    key={p.id}
                    item={p}
                    onChoose={() => choosePackage(p)}
                  />
                ))}
              </div>
            </section>
            <section className="how-section section">
              <div className="eyebrow">LESS PLANNING. MORE POSSIBILITY.</div>
              <h2>
                From &ldquo;what if&rdquo; to &ldquo;we&apos;re going.&rdquo;
              </h2>
              <div className="how-grid">
                {stepLabels.map((s, i) => (
                  <div key={s}>
                    <span className="step-number">0{i + 1}</span>
                    <h3>{s}</h3>
                    <p>
                      {
                        [
                          "Start with a feeling, your dates, and the things you love. Choose a curated journey or shape one with AI.",
                          "Save your day-by-day plan. Tweak the details, ask questions, and let your trip come into focus.",
                          "Our team checks availability and shares a quote. Review the details before secure hosted checkout.",
                        ][i]
                      }
                    </p>
                  </div>
                ))}
              </div>
            </section>
            <section className="closing-banner">
              <div>
                <div className="eyebrow light">
                  YOUR NEXT CHAPTER IS CALLING
                </div>
                <h2>
                  Come for the adventure.
                  <br />
                  <em>Leave with a little Kenya.</em>
                </h2>
              </div>
              <button
                className="button button-cream"
                onClick={() => go("planner")}
              >
                Let&apos;s make it happen <ArrowUpRight size={18} />
              </button>
            </section>
          </>
        )}

        {view === "destinations" && (
          <section className="section interior">
            <PageHeading
              eyebrow="FOLLOW YOUR CURIOSITY"
              title="A thousand ways to feel Kenya."
              text="Explore our curated destination collection. Activities, conditions and availability are confirmed personally by the agency."
            />
            <div className="filter-row">
              {[
                "All experiences",
                "Wildlife",
                "Beach",
                "Culture",
                "Adventure",
              ].map((f) => (
                <button
                  key={f}
                  className={`filter-chip ${filter === f ? "selected" : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="destination-grid all-destinations">
              {destinations
                .filter(
                  (d) =>
                    filter === "All experiences" ||
                    d.interests.includes(filter),
                )
                .map((d, i) => (
                  <DestinationCard
                    key={d.id}
                    item={d}
                    index={i}
                    onOpen={() => setDestination(d)}
                  />
                ))}
            </div>
          </section>
        )}
        {view === "journeys" && (
          <section className="section interior">
            <PageHeading
              eyebrow="THOUGHTFULLY CURATED. NEVER ONE-SIZE-FITS-ALL."
              title="Your next story starts here."
              text="A few considered routes to get you dreaming. Prices are illustrative estimates per person, not live rates or confirmed availability."
            />
            <div className="package-grid">
              {catalog.map((p) => (
                <PackageCard
                  key={p.id}
                  item={p}
                  onChoose={() => choosePackage(p)}
                />
              ))}
            </div>
            {!catalog.length && (
              <Empty
                icon={<Compass />}
                title="Fresh journeys are on the way."
                text="Contact the agency to request a personal trip."
              />
            )}
          </section>
        )}

        {view === "planner" && (
          <section className="section interior planner-page">
            <PageHeading
              eyebrow="LET'S MAKE ROOM FOR WONDER"
              title="A journey that's yours."
              text="Start with your preferences. Save a curated route or let a connected AI assistant look up our catalog and build a validated itinerary."
            />
            <div className="planner-layout">
              <div className="panel preferences-panel">
                <div className="panel-title">
                  <span className="small-icon">
                    <Compass size={18} />
                  </span>
                  <h3>The shape of your trip</h3>
                </div>
                <div className="segmented">
                  <button
                    className={plannerMode === "curated" ? "active" : ""}
                    onClick={() => setPlannerMode("curated")}
                  >
                    Curated journey
                  </button>
                  <button
                    className={plannerMode === "ai" ? "active" : ""}
                    onClick={() => setPlannerMode("ai")}
                  >
                    <Sparkles size={13} /> AI personal plan
                  </button>
                </div>
                <form onSubmit={saveCurated} className="form-stack">
                  {plannerMode === "curated" && (
                    <label>
                      Start with a journey
                      <select
                        value={selectedPackage}
                        onChange={(e) => {
                          const p = catalog.find(
                            (c) => c.id === e.target.value,
                          )!;
                          setSelectedPackage(p.id);
                          setPreferences((old) => ({
                            ...old,
                            endDate: old.startDate
                              ? dateForDay(old.startDate, p.days - 1)
                              : old.endDate,
                          }));
                        }}
                      >
                        {catalog.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} · {p.days} days
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="two-columns">
                    <label>
                      Arrival date
                      <input
                        required
                        type="date"
                        min={new Date().toISOString().slice(0, 10)}
                        value={preferences.startDate}
                        onChange={(e) =>
                          setPreferences((p) => ({
                            ...p,
                            startDate: e.target.value,
                            endDate: e.target.value
                              ? dateForDay(
                                  e.target.value,
                                  plannerMode === "curated"
                                    ? (catalog.find(
                                        (c) => c.id === selectedPackage,
                                      )?.days ?? 6) - 1
                                    : 5,
                                )
                              : p.endDate,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Last trip day
                      <input
                        required
                        type="date"
                        min={preferences.startDate}
                        value={preferences.endDate}
                        onChange={(e) =>
                          setPreferences((p) => ({
                            ...p,
                            endDate: e.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="field-note">
                    2–14 days, including your first and last days. Curated
                    routes have a fixed duration.
                  </div>
                  <label>
                    Travellers
                    <div className="party-input">
                      <span>
                        <Users size={16} /> {preferences.partySize}{" "}
                        {preferences.partySize === 1
                          ? "traveller"
                          : "travellers"}
                      </span>
                      <button
                        type="button"
                        aria-label="Fewer travellers"
                        disabled={preferences.partySize <= 1}
                        onClick={() =>
                          setPreferences((p) => ({
                            ...p,
                            partySize: p.partySize - 1,
                          }))
                        }
                      >
                        <Minus size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label="More travellers"
                        disabled={preferences.partySize >= 12}
                        onClick={() =>
                          setPreferences((p) => ({
                            ...p,
                            partySize: p.partySize + 1,
                          }))
                        }
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </label>
                  <div className="budget-row">
                    <label>
                      Total party budget
                      <input
                        type="number"
                        min={100}
                        max={1000000}
                        required
                        value={preferences.budget}
                        onChange={(e) =>
                          setPreferences((p) => ({
                            ...p,
                            budget: Number(e.target.value),
                          }))
                        }
                      />
                    </label>
                    <label>
                      Currency
                      <select
                        value={preferences.currency}
                        onChange={(e) =>
                          setPreferences((p) => ({
                            ...p,
                            currency: e.target.value as Preferences["currency"],
                          }))
                        }
                      >
                        <option>USD</option>
                        <option>KES</option>
                      </select>
                    </label>
                  </div>
                  <fieldset>
                    <legend>What moves you?</legend>
                    <div className="interest-grid">
                      {interests.map((interest) => (
                        <button
                          type="button"
                          key={interest}
                          aria-pressed={preferences.interests.includes(
                            interest,
                          )}
                          className={`interest-chip ${preferences.interests.includes(interest) ? "selected" : ""}`}
                          onClick={() =>
                            setPreferences((p) => ({
                              ...p,
                              interests: p.interests.includes(interest)
                                ? p.interests.filter((i) => i !== interest)
                                : [...p.interests, interest],
                            }))
                          }
                        >
                          {preferences.interests.includes(interest) && (
                            <Check size={12} />
                          )}
                          {interest}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  {plannerMode === "curated" ? (
                    <button
                      className="button full-width"
                      disabled={busy || !ready || !catalog.length}
                    >
                      Save my itinerary <ArrowRight size={16} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button full-width"
                      disabled={busy || !ready || !session.aiReady}
                      onClick={() => generate("plan")}
                    >
                      <Sparkles size={16} />
                      {activePlan
                        ? "Create a refined plan"
                        : "Create my itinerary"}
                    </button>
                  )}
                  <p className="field-note">
                    <LockKeyhole size={12} /> Sign in to save. No payment at
                    this stage.
                  </p>
                </form>
              </div>
              <div className="planner-main">
                <div className="panel assistant-panel">
                  <div className="panel-title">
                    <span className="sparkle-disc">
                      <Sparkles size={19} />
                    </span>
                    <div>
                      <h3>A little help finding your Kenya</h3>
                      <span className="field-note">
                        {session.aiReady
                          ? "Catalog-grounded AI · not a live external search"
                          : "AI not connected · curated planning is available"}
                      </span>
                    </div>
                    <span
                      className={`connection-dot ${session.aiReady ? "connected" : ""}`}
                    />
                  </div>
                  {!session.aiReady && (
                    <div className="setup-note">
                      <CircleHelp size={17} />
                      <span>
                        AI needs server configuration. Until then, choose a
                        curated route or{" "}
                        <button
                          className="inline-link"
                          onClick={() => go("contact")}
                        >
                          message the agency
                        </button>
                        . We never present canned plans as AI-generated.
                      </span>
                    </div>
                  )}
                  <div className="chat-messages" aria-live="polite">
                    {chat.map((m, i) => (
                      <div className={`chat-bubble ${m.role}`} key={i}>
                        {m.role === "assistant" && <Sparkles size={14} />}
                        <span>{m.text}</span>
                      </div>
                    ))}
                  </div>
                  <label className="sr-only" htmlFor="ai-message">
                    Your travel enquiry or itinerary refinement
                  </label>
                  <div className="chat-input">
                    <textarea
                      id="ai-message"
                      placeholder="Wildlife, quiet places, a little adventure..."
                      value={prompt}
                      maxLength={2000}
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                    <button
                      className="icon-button"
                      aria-label="Ask AI a travel question"
                      disabled={busy || !session.aiReady}
                      onClick={() => generate("enquiry")}
                    >
                      <Send size={19} />
                    </button>
                  </div>
                  <div className="field-note chat-note">
                    Use the question button for enquiries; &ldquo;Create my
                    itinerary&rdquo; builds or refines a saved trip. Prompts and
                    travel preferences are sent to OpenAI when connected.
                    Don&apos;t share private documents or payment details.
                  </div>
                </div>
                {activePlan ? (
                  <ItineraryCard
                    plan={activePlan}
                    booking={trips.bookings.find(
                      (b) => b.plan_id === activePlan.id,
                    )}
                    busy={busy}
                    onBook={() => booking(activePlan.id)}
                    onCheckout={checkout}
                    paymentReady={session.paymentReady}
                  />
                ) : (
                  <div className="plan-placeholder">
                    <span className="large-compass">
                      <Compass size={38} strokeWidth={1} />
                    </span>
                    <h3>A little possibility. A lot to look forward to.</h3>
                    <p>
                      Your saved day-by-day itinerary will appear here.
                      <br />
                      Every estimate is checked against your preferences.
                    </p>
                    <div>
                      <span>
                        <CalendarDays size={14} /> Your dates
                      </span>
                      <span>
                        <MapPin size={14} /> Your places
                      </span>
                      <span>
                        <Users size={14} /> Your people
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {view === "trips" && (
          <section className="section interior">
            <div className="section-top">
              <PageHeading
                eyebrow="YOUR NEXT CHAPTER"
                title={
                  session.user
                    ? `Good to see you, ${session.user.name.split(" ")[0]}.`
                    : "Keep your Kenya close."
                }
                text="Saved ideas, agency quotes and booking progress, all in one place."
              />
              {session.user && (
                <button
                  className="underlined-link"
                  disabled={busy}
                  onClick={() => run(refresh)}
                >
                  Refresh trips <ArrowRight size={16} />
                </button>
              )}
            </div>
            {!session.user ? (
              <Empty
                icon={<LockKeyhole />}
                title="Your journeys are just for you."
                text="Sign in to access your privately saved trips and bookings."
                action={
                  <button className="button" onClick={() => setAuth("login")}>
                    Sign in <ArrowRight size={15} />
                  </button>
                }
              />
            ) : (
              <>
                <div className="panel account-security">
                  <h3>Account sign-in</h3>
                  {session.googleLinked ? (
                    <p className="muted">
                      <Check size={15} /> Google is connected. You can use
                      Google to access this same account and its saved trips.
                    </p>
                  ) : (
                    <>
                      <p className="muted">
                        Already have a Google account with this email? Connect
                        it without losing your saved trips. Confirm your current
                        Sanaa password first. Connecting Google never changes
                        your agency permissions.
                      </p>
                      <form
                        className="form-stack"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const password = String(
                            new FormData(event.currentTarget).get(
                              "linkPassword",
                            ),
                          );
                          event.currentTarget.reset();
                          startGoogle("link", password);
                        }}
                      >
                        <label>
                          Current account password
                          <input
                            name="linkPassword"
                            type="password"
                            autoComplete="current-password"
                            required
                            minLength={12}
                            maxLength={128}
                            disabled={!session.googleReady || busy}
                          />
                        </label>
                        <button
                          className="google-button"
                          disabled={busy || !ready || !session.googleReady}
                        >
                          <span className="google-mark" aria-hidden="true">
                            G
                          </span>{" "}
                          Connect Google account
                        </button>
                      </form>
                      {!session.googleReady && (
                        <p className="field-note">
                          Google sign-in is not configured yet. The server needs
                          GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET; existing
                          email/password sign-in still works.
                        </p>
                      )}
                    </>
                  )}
                </div>
                {!trips.plans.length && (
                  <Empty
                    icon={<Compass />}
                    title="Leave a little room for adventure."
                    text="Your first saved itinerary belongs right here."
                    action={
                      <button className="button" onClick={() => go("planner")}>
                        Build my trip <ArrowRight size={15} />
                      </button>
                    }
                  />
                )}
                <div className="saved-trips">
                  {trips.plans.map((p) => (
                    <div key={p.id}>
                      <ItineraryCard
                        plan={p}
                        booking={trips.bookings.find((b) => b.plan_id === p.id)}
                        busy={busy}
                        onBook={() => booking(p.id)}
                        onCheckout={checkout}
                        paymentReady={session.paymentReady}
                      />
                      <button
                        className="underlined-link refine-link"
                        onClick={() => {
                          setActivePlan(p);
                          setPreferences(p.preferences);
                          setPlannerMode("ai");
                          go("planner");
                        }}
                      >
                        Refine with AI <Sparkles size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                {trips.enquiries.length > 0 && (
                  <section className="enquiry-list">
                    <h2>Your conversations</h2>
                    {trips.enquiries.map((e) => (
                      <div className="panel" key={e.id}>
                        <p>{e.message}</p>
                        <div className="agency-reply">
                          <MessageCircle size={16} />
                          {e.reply ||
                            "Your message is saved. The agency has not replied yet."}
                        </div>
                      </div>
                    ))}
                  </section>
                )}
              </>
            )}
          </section>
        )}

        {view === "contact" && (
          <section className="section interior">
            <PageHeading
              eyebrow="REAL PEOPLE. THOUGHTFUL JOURNEYS."
              title="A personal touch, from hello."
              text="Sanaa Kenya is a provisional name for this single-agency MVP. Our approach is simple: inspiring ideas, honest estimates, and a real conversation before you book."
            />
            <div className="contact-layout">
              <div>
                <div className="principle">
                  <ShieldCheck />
                  <div>
                    <h3>Clarity before commitment</h3>
                    <p>
                      The catalog uses illustrative content and sample rates.
                      Your agency quote must state checked availability,
                      accommodation, transfers, inclusions, exclusions and
                      terms.
                    </p>
                  </div>
                </div>
                <div className="principle">
                  <Leaf />
                  <div>
                    <h3>A more considered adventure</h3>
                    <p>
                      Tell us your interests and pace. Wildlife sightings are
                      never guaranteed, community visits depend on consent, and
                      outdoor experiences depend on conditions.
                    </p>
                  </div>
                </div>
                <div className="principle">
                  <LockKeyhole />
                  <div>
                    <h3>Private plans. Hosted payments.</h3>
                    <p>
                      Your plans and messages are only visible to you and, when
                      submitted, the agency. Card details stay with the payment
                      provider. This release allows test payments only.
                    </p>
                  </div>
                </div>
                <div className="setup-note">
                  This is a development MVP, not an operating agency guarantee.
                  Do not submit passports, health information, card details or
                  other sensitive documents.
                </div>
              </div>
              <div className="panel">
                <h3>Let&apos;s talk about your trip</h3>
                <p className="muted">
                  Ask about a route, a quote, or a detail that matters to you.
                  Your message and the agency&apos;s reply stay in My trips.
                </p>
                <form
                  className="form-stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!signedIn()) return;
                    const data = new FormData(e.currentTarget);
                    const form = e.currentTarget;
                    run(async () => {
                      await api("enquiries", {
                        message: String(data.get("message")),
                      });
                      await refresh();
                      form.reset();
                      setNotice(
                        "Your enquiry is saved. Find the agency's reply in My trips.",
                      );
                    });
                  }}
                >
                  <label>
                    Your message
                    <textarea
                      name="message"
                      required
                      minLength={10}
                      maxLength={3000}
                      rows={6}
                      placeholder="Tell us a little about the trip you have in mind..."
                    />
                  </label>
                  <button className="button" disabled={busy}>
                    Send to the agency <Send size={15} />
                  </button>
                  <span className="field-note">
                    An account is required so your conversation stays private.
                  </span>
                </form>
              </div>
            </div>
          </section>
        )}

        {view === "agency" && (
          <section className="section interior">
            <div className="section-top">
              <PageHeading
                eyebrow="AGENCY WORKSPACE"
                title="Make the details count."
                text="Review trip requests, confirm availability offline, issue quotes and respond to enquiries. No payment can be marked paid manually."
              />
              {session.user?.role === "admin" && (
                <button
                  className="underlined-link"
                  disabled={busy}
                  onClick={() =>
                    run(async () =>
                      setAdmin(await api<AdminData>("admin/overview")),
                    )
                  }
                >
                  Refresh dashboard <ArrowRight size={16} />
                </button>
              )}
            </div>
            {session.user?.role !== "admin" ? (
              <Empty
                icon={<LockKeyhole />}
                title="Agency access only"
                text="Sign in with a provisioned agency administrator account. Registration never grants agency access."
                action={
                  <button className="button" onClick={() => setAuth("login")}>
                    Agency sign in
                  </button>
                }
              />
            ) : admin ? (
              <>
                <div className="stat-grid">
                  <Stat
                    label="Requests to review"
                    value={
                      admin.bookings.filter((b) => b.status === "requested")
                        .length
                    }
                  />
                  <Stat
                    label="Quoted / payment pending"
                    value={
                      admin.bookings.filter((b) =>
                        ["quoted", "payment_pending"].includes(b.status),
                      ).length
                    }
                  />
                  <Stat
                    label="Test payments received"
                    value={
                      admin.bookings.filter((b) => b.status === "paid").length
                    }
                  />
                  <Stat
                    label="Unanswered enquiries"
                    value={admin.enquiries.filter((e) => !e.reply).length}
                  />
                </div>
                <h2 className="dashboard-heading">Booking requests</h2>
                {!admin.bookings.length && (
                  <p className="muted">No booking requests yet.</p>
                )}
                <div className="admin-bookings">
                  {admin.bookings.map((b) => (
                    <div className="panel" key={b.id}>
                      <div className="section-top">
                        <div>
                          <span className={`status-badge ${b.status}`}>
                            {b.status.replace("_", " ")}
                          </span>
                          <h3>{b.title}</h3>
                          <p className="muted">
                            {b.name} · {b.email}
                          </p>
                          <span className="field-note">
                            Request {b.id.slice(0, 8)}
                          </span>
                        </div>
                      </div>
                      {admin.plans.find((p) => p.id === b.plan_id) && (
                        <PlanDetails
                          plan={admin.plans.find((p) => p.id === b.plan_id)!}
                        />
                      )}
                      <QuoteDetails booking={b} />
                      {["requested", "quoted"].includes(b.status) ? (
                        <form
                          className="form-stack quote-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            run(async () => {
                              await api("admin/quote", {
                                bookingId: b.id,
                                amount: Number(f.get("amount")),
                                currency: f.get("currency"),
                                notes: f.get("notes"),
                                expiresAt: f.get("expiresAt"),
                              });
                              setAdmin(await api<AdminData>("admin/overview"));
                              setNotice(
                                "Agency quote issued. The traveller can review it in My trips.",
                              );
                            });
                          }}
                        >
                          <div className="three-columns">
                            <label>
                              Total quote amount
                              <input
                                type="number"
                                name="amount"
                                min={1}
                                max={1000000}
                                step="0.01"
                                required
                                defaultValue={
                                  b.quote_amount
                                    ? b.quote_amount / 100
                                    : undefined
                                }
                              />
                            </label>
                            <label>
                              Currency
                              <select
                                name="currency"
                                defaultValue={b.quote_currency || "USD"}
                              >
                                <option>USD</option>
                                <option>KES</option>
                              </select>
                            </label>
                            <label>
                              Valid through (UTC)
                              <input
                                type="date"
                                name="expiresAt"
                                min={new Date().toISOString().slice(0, 10)}
                                required
                                defaultValue={b.quote_expires || undefined}
                              />
                            </label>
                          </div>
                          <label>
                            Confirmed availability, inclusions, exclusions &
                            terms
                            <textarea
                              name="notes"
                              rows={4}
                              minLength={10}
                              maxLength={2000}
                              required
                              defaultValue={b.quote_notes || ""}
                              placeholder="Record checked availability, accommodation, transfers, included services, exclusions and cancellation terms."
                            />
                          </label>
                          <label className="check-label">
                            <input type="checkbox" required /> I have checked
                            availability and the quote terms outside this app.
                            This is a test-mode quote.
                          </label>
                          <button className="button" disabled={busy}>
                            Issue agency quote <ArrowRight size={15} />
                          </button>
                        </form>
                      ) : (
                        <div className="setup-note">
                          {b.status === "paid"
                            ? "Test payment received via verified webhook. This does not reserve suppliers or finalize travel arrangements."
                            : "Checkout is reserved. Quote changes are locked until the provider reports failure or expiry. A cancelled browser checkout is not a failed payment."}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <h2 className="dashboard-heading">Enquiries</h2>
                {!admin.enquiries.length && (
                  <p className="muted">No enquiries yet.</p>
                )}
                {admin.enquiries.map((e) => (
                  <div className="panel admin-enquiry" key={e.id}>
                    <strong>
                      {e.name} · {e.email}
                    </strong>
                    <p>{e.message}</p>
                    <form
                      className="form-stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const reply = String(
                          new FormData(event.currentTarget).get("reply"),
                        );
                        run(async () => {
                          await api("admin/reply", { id: e.id, reply });
                          setAdmin(await api<AdminData>("admin/overview"));
                          setNotice("Reply saved to the traveller's account.");
                        });
                      }}
                    >
                      <label>
                        Agency reply
                        <textarea
                          name="reply"
                          required
                          minLength={3}
                          maxLength={3000}
                          defaultValue={e.reply || ""}
                        />
                      </label>
                      <button className="button button-small" disabled={busy}>
                        Save reply <Send size={14} />
                      </button>
                    </form>
                  </div>
                ))}
                <h2 className="dashboard-heading">Curated catalog</h2>
                <p className="muted">
                  Manage public descriptions and visibility. Route and sample
                  rate changes are maintained in the seed catalog code; existing
                  saved plans remain unchanged.
                </p>
                <div className="package-grid">
                  {admin.packages.map((p) => (
                    <form
                      key={p.id}
                      className="panel form-stack"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        run(async () => {
                          await api("admin/package", {
                            id: p.id,
                            description: f.get("description"),
                            active: f.get("active") === "on",
                          });
                          setAdmin(await api<AdminData>("admin/overview"));
                          const data = await api<{ packages: TravelPackage[] }>(
                            "catalog",
                          );
                          setCatalog(data.packages);
                          setNotice("Catalog updated.");
                        });
                      }}
                    >
                      <h3>{p.name}</h3>
                      <label>
                        Description
                        <textarea
                          name="description"
                          required
                          minLength={20}
                          maxLength={2000}
                          rows={5}
                          defaultValue={p.description}
                        />
                      </label>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          name="active"
                          defaultChecked={p.active}
                        />{" "}
                        Visible to travellers
                      </label>
                      <button className="button button-small" disabled={busy}>
                        Save catalog changes
                      </button>
                    </form>
                  ))}
                </div>
              </>
            ) : (
              <Empty
                icon={<LayoutDashboard />}
                title="Open your agency workspace"
                text="Load the latest requests, quotes, enquiries and catalog."
                action={
                  <button
                    className="button"
                    disabled={busy}
                    onClick={openAgency}
                  >
                    Load dashboard
                  </button>
                }
              />
            )}
          </section>
        )}
      </main>
      <footer className="footer">
        <div className="footer-top">
          <div>
            <a
              className="brand footer-brand"
              href="#home"
              onClick={(e) => {
                e.preventDefault();
                go("home");
              }}
            >
              <Compass size={28} strokeWidth={1.3} />
              <span>
                sanaa<span className="brand-country">KENYA</span>
              </span>
              <span className="brand-dot">.</span>
            </a>
            <p>
              Not just a trip.
              <br />A little more alive.
            </p>
          </div>
          <div>
            <strong>Find your Kenya</strong>
            <button onClick={() => go("destinations")}>
              Explore destinations
            </button>
            <button onClick={() => go("journeys")}>Curated journeys</button>
            <button onClick={() => go("planner")}>Build your trip</button>
          </div>
          <div>
            <strong>Here for your journey</strong>
            <button onClick={() => go("contact")}>Contact the agency</button>
            <button onClick={() => go("trips")}>My trips & enquiries</button>
            <button onClick={openAgency}>Agency workspace</button>
          </div>
          <div className="footer-note">
            <span>
              <MapPin size={14} /> Inspired by Kenya.
            </span>
            <p>
              Provisional brand · Development MVP
              <br />
              Illustrative catalog · Test payments only
            </p>
          </div>
        </div>
        <div className="footer-bottom">
          <span>
            © {new Date().getFullYear()} Sanaa Kenya. A provisional travel
            concept.
          </span>
          <span>Made for the curious. Designed to be personal.</span>
        </div>
      </footer>
      <button
        className="floating-chat"
        aria-label="Open trip planning assistant"
        onClick={() => {
          setPlannerMode("ai");
          go("planner");
        }}
      >
        <MessageCircle size={21} />
        <span>Let&apos;s plan something</span>
        <Sparkles size={13} />
      </button>
      {busy && (
        <div className="working-indicator" role="status">
          <span className="spinner" /> Working on the details...
        </div>
      )}
      {auth && (
        <Modal
          title={
            auth === "register"
              ? "Your next chapter starts here."
              : "Welcome back, explorer."
          }
          onClose={closeAuth}
        >
          <p className="muted">
            {auth === "register"
              ? "Create a private account to save plans, talk to the agency and manage your booking."
              : "Sign in to your saved plans, quotes and conversations."}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="google-button full-width"
            disabled={busy || !ready || !session.googleReady}
            onClick={() => startGoogle("signin")}
          >
            <span className="google-mark" aria-hidden="true">
              G
            </span>{" "}
            Continue with Google
          </button>
          {!session.googleReady && (
            <p className="field-note google-setup-note">
              Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID and
              GOOGLE_CLIENT_SECRET on the server to enable it. You can still use
              email and password below.
            </p>
          )}
          <div className="auth-divider">
            <span>or use email</span>
          </div>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              run(async () => {
                const result = await api<{ user: User }>(`auth/${auth}`, {
                  email: data.get("email"),
                  password: data.get("password"),
                  ...(auth === "register" ? { name: data.get("name") } : {}),
                });
                const s = await api<Session>("session");
                setSession(s);
                setAuth(null);
                setAdmin(null);
                await refresh();
                setNotice(
                  `You're signed in as ${result.user.name}. Your next adventure is waiting.`,
                );
              });
            }}
          >
            {auth === "register" && (
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  required
                  minLength={2}
                  maxLength={80}
                />
              </label>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={
                  auth === "register" ? "new-password" : "current-password"
                }
                required
                minLength={12}
                maxLength={128}
              />
            </label>
            <span className="field-note">
              At least 12 characters. Use a unique password.
            </span>
            <button className="button full-width" disabled={busy}>
              {auth === "register" ? "Create my account" : "Sign in"}
              <ArrowRight size={16} />
            </button>
          </form>
          <p className="auth-switch">
            {auth === "register" ? "Already have an account?" : "New to Sanaa?"}{" "}
            <button
              className="inline-link"
              onClick={() => {
                setError("");
                setAuth(auth === "register" ? "login" : "register");
              }}
            >
              {auth === "register" ? "Sign in" : "Create an account"}
            </button>
          </p>
          <div className="field-note">
            No email delivery or password recovery is connected in this local
            MVP. Do not use a real-world password.
          </div>
        </Modal>
      )}
      {destination && (
        <Modal title={destination.name} onClose={closeDestination}>
          <div
            className="destination-modal-image"
            style={{ backgroundImage: `url("${destination.image}")` }}
          />
          <span className="eyebrow">{destination.region}</span>
          <p>{destination.description}</p>
          <h3>A few ways to experience it</h3>
          <ul className="activity-list">
            {destination.activities.map((a) => (
              <li key={a.id}>
                <Check size={15} />
                {a.name}
              </li>
            ))}
          </ul>
          <p className="field-note">
            Sample estimate: {money(destination.dailyUsd, "USD")} per person per
            day. Not a live rate. Travel logistics and availability require
            agency confirmation.
          </p>
          <button
            className="button"
            onClick={() => {
              setPreferences((p) => ({
                ...p,
                interests: destination.interests,
              }));
              setDestination(null);
              go("planner");
            }}
          >
            Make room for {destination.name} <ArrowUpRight size={16} />
          </button>
        </Modal>
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  text,
}: {
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <div className="page-heading">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{text}</p>
    </div>
  );
}
function DestinationCard({
  item,
  index,
  onOpen,
}: {
  item: Destination;
  index: number;
  onOpen: () => void;
}) {
  return (
    <button
      className="destination-card"
      onClick={onOpen}
      style={{ backgroundImage: `url("${item.image}")` }}
    >
      <span className="destination-number">0{index + 1}</span>
      <span className="destination-content">
        <span className="eyebrow light">{item.eyebrow}</span>
        <span className="destination-name">{item.name}</span>
        <span className="destination-bottom">
          {item.region}
          <span className="round-arrow">
            <ArrowUpRight size={18} />
          </span>
        </span>
      </span>
    </button>
  );
}
function PackageCard({
  item,
  onChoose,
}: {
  item: TravelPackage;
  onChoose: () => void;
}) {
  const estimate = item.route.reduce(
    (total, id) => total + (destinationById(id)?.dailyUsd || 0),
    0,
  );
  return (
    <article className="package-card">
      <button
        onClick={onChoose}
        className="package-image"
        style={{ backgroundImage: `url("${item.image}")` }}
        aria-label={`Plan ${item.name}`}
      >
        <span>{item.days} DAYS · PRIVATE JOURNEY</span>
        <span className="round-arrow">
          <ArrowUpRight size={18} />
        </span>
      </button>
      <div className="package-copy">
        <div className="eyebrow">{item.tag}</div>
        <h3>{item.name}</h3>
        <p>
          <MapPin size={12} />
          {item.subtitle}
        </p>
        <div className="package-bottom">
          <span>
            <strong>{money(estimate, "USD")}</strong> <small>/ person</small>
            <span className="estimate-label">Illustrative estimate</span>
          </span>
          <button className="text-button" onClick={onChoose}>
            Discover <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </article>
  );
}
function ItineraryCard({
  plan,
  booking,
  busy,
  onBook,
  onCheckout,
  paymentReady,
}: {
  plan: Plan;
  booking?: Booking;
  busy: boolean;
  onBook: () => void;
  onCheckout: (id: string) => void;
  paymentReady: boolean;
}) {
  return (
    <article className="panel itinerary-card">
      <div className="itinerary-header">
        <div className="eyebrow">
          {plan.source === "ai"
            ? "AI-ASSISTED · CATALOG-VALIDATED"
            : "CURATED CATALOG ITINERARY"}
        </div>
        <span className={`status-badge ${booking?.status || "estimated"}`}>
          {booking?.status.replace("_", " ") || "estimated"}
        </span>
      </div>
      <h2>{plan.itinerary.title}</h2>
      <p className="muted">{plan.itinerary.summary}</p>
      <PlanDetails plan={plan} />
      <QuoteDetails booking={booking} />
      {!booking ? (
        <button className="button" disabled={busy} onClick={onBook}>
          Request an agency quote <ArrowRight size={16} />
        </button>
      ) : ["quoted", "payment_pending"].includes(booking.status) ? (
        <>
          <button
            className="button"
            disabled={
              busy ||
              !paymentReady ||
              !booking.quote_expires ||
              booking.quote_expires < new Date().toISOString().slice(0, 10)
            }
            onClick={() => onCheckout(booking.id)}
          >
            <LockKeyhole size={15} />
            {booking.status === "payment_pending"
              ? "Resume test checkout"
              : "Accept quote & test checkout"}
          </button>
          {!paymentReady && (
            <p className="field-note">
              Test checkout is not configured. Your quote remains saved; no
              payment has been taken.
            </p>
          )}
          {booking.quote_expires &&
            booking.quote_expires < new Date().toISOString().slice(0, 10) && (
              <p className="form-error">
                Quote expired. Contact the agency for a refreshed quote.
              </p>
            )}
        </>
      ) : (
        <div className="setup-note">
          {booking.status === "paid" ? (
            <>
              <ShieldCheck size={18} /> Test payment received. This is not a
              real travel reservation. The agency must finalize supplier
              arrangements separately.
            </>
          ) : (
            <>
              <MessageCircle size={18} /> Request saved. The agency will check
              availability and send a quote here. No payment is due yet.
            </>
          )}
        </div>
      )}
      <div className="field-note itinerary-footnote">
        Saved privately.{" "}
        {booking
          ? `Request reference: ${booking.id.slice(0, 8)}`
          : "The agency sees this plan when you request a quote."}
      </div>
    </article>
  );
}
function PlanDetails({ plan }: { plan: Plan }) {
  return (
    <>
      <div className="trip-meta">
        <span>
          <CalendarDays size={14} />
          {plan.preferences.startDate} — {plan.preferences.endDate}
        </span>
        <span>
          <Users size={14} />
          {plan.preferences.partySize} travellers
        </span>
        <span>
          {duration(plan.preferences.startDate, plan.preferences.endDate)} days
        </span>
      </div>
      <details className="day-details">
        <summary>
          Explore your day-by-day itinerary <ChevronRight size={15} />
        </summary>
        <div className="day-list">
          {plan.itinerary.days.map((day) => (
            <div className="day" key={day.day}>
              <span className="day-number">
                {String(day.day).padStart(2, "0")}
              </span>
              <div>
                <small>{day.date}</small>
                <h4>{day.destinationName}</h4>
                <p>
                  {day.travelOnly
                    ? "Road transfer day · no scheduled activities"
                    : day.activities.join(" · ")}
                </p>
                {day.transferHours > 0 && (
                  <span className="field-note">
                    Allow approximately {day.transferHours} road hours. Timing
                    depends on conditions.
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </details>
      <div
        className={`estimate-box ${!plan.itinerary.estimate.withinBudget ? "over-budget" : ""}`}
      >
        <div>
          <span>
            Illustrative total · {plan.preferences.partySize} travellers
          </span>
          <strong>
            {money(
              plan.itinerary.estimate.amount,
              plan.itinerary.estimate.currency,
            )}
          </strong>
        </div>
        <span className="budget-label">
          {plan.itinerary.estimate.withinBudget
            ? "Within your sample budget"
            : "Above your stated budget"}
        </span>
        <small>{plan.itinerary.estimate.rateNote}</small>
      </div>
    </>
  );
}
function QuoteDetails({ booking }: { booking?: Booking }) {
  if (!booking?.quote_amount) return null;
  return (
    <div className="quote-box">
      <div className="eyebrow">AGENCY-ISSUED QUOTE · TEST MODE</div>
      <strong>
        {new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: booking.quote_currency!,
          minimumFractionDigits: 2,
        }).format(booking.quote_amount / 100)}
      </strong>
      <span>Valid through {booking.quote_expires} (UTC)</span>
      <p>{booking.quote_notes}</p>
      <small>
        The quote, not the sample estimate, determines your checkout amount.
        Accepting it opens the provider&apos;s test checkout.
      </small>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="large-compass">{icon}</span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const dialog = document.getElementById("active-dialog");
        const focusable = dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input,textarea,select,a[href]",
        );
        if (!focusable?.length) return;
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", key);
    document.getElementById("dialog-close")?.focus();
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        id="active-dialog"
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <button
          id="dialog-close"
          className="icon-button modal-close"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={21} />
        </button>
        <div className="eyebrow">KARIBU · WELCOME</div>
        <h2 id="modal-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}
