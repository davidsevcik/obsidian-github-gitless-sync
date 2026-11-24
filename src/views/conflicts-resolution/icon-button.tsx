import * as React from "react";
import { setIcon } from "obsidian";

interface IconButtonProps {
  icon: string;
  label: string;
  // Shown if the icon is missing in this Obsidian version
  fallbackText: string;
  disabled?: boolean;
  onClick: (event: React.MouseEvent) => void;
}

const IconButton: React.FC<IconButtonProps> = ({
  icon,
  label,
  fallbackText,
  disabled,
  onClick,
}) => {
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const button = ref.current!;
    setIcon(button, icon);
    if (button.childElementCount === 0) {
      button.setText(fallbackText);
    }
  }, [icon]);
  return (
    <button
      ref={ref}
      className="clickable-icon"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    />
  );
};

export default IconButton;
