import * as React from "react";
import { Menu, Platform } from "obsidian";
import IconButton from "../icon-button";

interface UnifiedResolutionBarProps {
  onAcceptRemote: () => void;
  onAcceptLocal: () => void;
  /// Only set when the conflict has lines from both documents
  onAcceptBoth?: () => void;
  onDiscardBoth?: () => void;
}

/// Component that shows buttons the user can click to resolve conflicts
const UnifiedResolutionBar: React.FC<UnifiedResolutionBarProps> = ({
  onAcceptRemote,
  onAcceptLocal,
  onAcceptBoth,
  onDiscardBoth,
}) => {
  // Text links are too small to tap, on mobile the two main choices are
  // buttons and the rarer ones go in a menu
  if (Platform.isMobile) {
    const hasMore = onAcceptBoth !== undefined || onDiscardBoth !== undefined;
    const showMore = (event: React.MouseEvent) => {
      const menu = new Menu();
      if (onAcceptBoth) {
        menu.addItem((item) =>
          item.setTitle("Accept both").onClick(onAcceptBoth),
        );
      }
      if (onDiscardBoth) {
        menu.addItem((item) =>
          item.setTitle("Discard both").onClick(onDiscardBoth),
        );
      }
      menu.showAtMouseEvent(event.nativeEvent);
    };
    return (
      <div className="conflicts-chunk-buttons">
        <button onClick={onAcceptRemote}>Accept remote</button>
        <button onClick={onAcceptLocal}>Accept local</button>
        {hasMore && (
          <IconButton
            icon="more-horizontal"
            label="More choices"
            fallbackText="⋯"
            onClick={showMore}
          />
        )}
      </div>
    );
  }

  const renderActions = () => {
    return (
      <>
        <ClickableText text="Accept remote" onClick={onAcceptRemote} />
        {" | "}
        <ClickableText text="Accept local" onClick={onAcceptLocal} />
        {onAcceptBoth && (
          <>
            {" | "}
            <ClickableText text="Accept both" onClick={onAcceptBoth} />
          </>
        )}
        {onDiscardBoth && (
          <>
            {" | "}
            <ClickableText text="Discard both" onClick={onDiscardBoth} />
          </>
        )}
      </>
    );
  };

  return (
    <div
      style={{
        display: "flex",
        justifyItems: "left",
        fontSize: "var(--font-ui-small)",
        fontFamily: "var(--font-interface)",
        color: "var(--text-muted)",
        backgroundColor: "var(--background-secondary)",
        padding: "var(--size-2-2)",
        paddingLeft: "var(--size-2-3)",
        userSelect: "none",
      }}
    >
      {renderActions()}
    </div>
  );
};

interface ClickableTextProps {
  text: string;
  onClick: () => void;
}

const ClickableText: React.FC<ClickableTextProps> = ({ text, onClick }) => {
  const [hovered, setHovered] = React.useState(false);

  return (
    <div
      style={{
        cursor: "pointer",
        color: hovered ? "var(--text-accent)" : "inherit",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      {text}
    </div>
  );
};

export default UnifiedResolutionBar;
