import { useEffect, useState } from "react";
import { Classroom } from "./classroom/Classroom";
import { LessonList } from "./pages/LessonList";
import { SessionReview } from "./pages/SessionReview";
import { SettingsPage } from "./pages/SettingsPage";

// Hash routes keep the static build servable from any path without server-side routing.
type Route =
  | { page: "lessons" }
  | { page: "settings" }
  | { page: "classroom"; lessonId: string }
  | { page: "session"; sessionId: string };

export function parseRoute(hash: string): Route {
  const lesson = /^#\/lessons\/([^/]+)$/.exec(hash);
  if (lesson) return { page: "classroom", lessonId: decodeURIComponent(lesson[1]!) };
  const session = /^#\/sessions\/([^/]+)$/.exec(hash);
  if (session) return { page: "session", sessionId: decodeURIComponent(session[1]!) };
  if (hash === "#/settings") return { page: "settings" };
  return { page: "lessons" };
}

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  switch (route.page) {
    case "classroom":
      // A fresh classroom per lesson, so no state leaks between lessons.
      return <Classroom key={route.lessonId} lessonId={route.lessonId} />;
    case "session":
      return <SessionReview key={route.sessionId} sessionId={route.sessionId} />;
    case "settings":
      return <SettingsPage />;
    default:
      return <LessonList />;
  }
}
