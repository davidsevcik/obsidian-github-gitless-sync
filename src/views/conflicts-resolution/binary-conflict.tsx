import * as React from "react";
import { ConflictFile } from "src/sync-manager";
import { Side } from "./side";
import { formatSize, imageType } from "./binary-preview";

/// A file that isn't text can't be merged, one version replaces the other
const BinaryConflict: React.FC<{
  file: ConflictFile;
  onKeep: (side: Side) => void;
}> = ({ file, onKeep }) => {
  return (
    <div className="conflicts-binary">
      <p>
        This file isn't text, so its versions can't be merged. Keep one of them,
        it replaces the other.
      </p>
      <div className="conflicts-binary-versions">
        <Version
          title="Remote"
          filePath={file.filePath}
          bytes={file.remoteBytes}
          onKeep={() => onKeep("remote")}
        />
        <Version
          title="Local"
          filePath={file.filePath}
          bytes={file.localBytes}
          onKeep={() => onKeep("local")}
        />
      </div>
    </div>
  );
};

const Version: React.FC<{
  title: string;
  filePath: string;
  bytes?: ArrayBuffer;
  onKeep: () => void;
}> = ({ title, filePath, bytes, onKeep }) => {
  const type = imageType(filePath);
  const url = useObjectUrl(type ? bytes : undefined, type);
  const [broken, setBroken] = React.useState(false);
  return (
    <div className="conflicts-binary-version">
      <div className="conflicts-pane-header">{title}</div>
      {url && !broken && (
        <img
          className="conflicts-binary-image"
          src={url}
          alt={`${title} version`}
          onError={() => setBroken(true)}
        />
      )}
      {url && broken && <div>Can't show this image</div>}
      {bytes && <div>{formatSize(bytes.byteLength)}</div>}
      <button onClick={onKeep}>Keep {title.toLowerCase()}</button>
    </div>
  );
};

/// A URL of the bytes, revoked when they change or the component unmounts
const useObjectUrl = (bytes?: ArrayBuffer, type?: string) => {
  const [url, setUrl] = React.useState<string>();
  React.useEffect(() => {
    if (!bytes) {
      setUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes, type]);
  return url;
};

export default BinaryConflict;
