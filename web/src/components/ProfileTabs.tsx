import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { resolveIcon } from "../icons";
import type { ProfileInfo } from "../types";

interface Props {
  profiles: ProfileInfo[];
  activeProfile: string;
  onSelect: (id: string) => void;
}

function TabIcon({ icon }: { icon: string }) {
  const resolved = resolveIcon(icon);
  return (
    <span className={`profile-tab-icon icon-${resolved.kind}`} aria-hidden="true">
      {resolved.kind === "fa" ? (
        <FontAwesomeIcon icon={resolved.def} />
      ) : resolved.kind === "image" ? (
        <img src={resolved.src} alt="" draggable={false} />
      ) : (
        resolved.text
      )}
    </span>
  );
}

/**
 * Profile tab bar above the pad grid. Hidden for single-profile (legacy)
 * configs. Tapping a tab asks the server to switch profiles; the server
 * answers with a `pad.profile` notification and the client refetches state.
 */
export function ProfileTabs({ profiles, activeProfile, onSelect }: Props) {
  if (profiles.length <= 1) return null;
  return (
    <div className="profile-tabs" role="tablist" aria-label="Profiles">
      {profiles.map((p) => (
        <button
          key={p.id}
          role="tab"
          aria-selected={p.id === activeProfile}
          className={`profile-tab${p.id === activeProfile ? " active" : ""}`}
          onClick={() => onSelect(p.id)}
        >
          {p.icon && <TabIcon icon={p.icon} />}
          <span className="profile-tab-name">{p.name}</span>
        </button>
      ))}
    </div>
  );
}
