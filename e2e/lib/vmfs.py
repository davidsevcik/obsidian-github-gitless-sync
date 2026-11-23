#!/usr/bin/env python3
"""
File operations the E2E harness runs on the VM.

Reads one JSON request on stdin and writes one JSON response on stdout.
Requests travel on stdin so paths need no shell quoting and the GitHub
token, written in the plugin settings, never shows up in a command line.
Every path is confined to an E2E vault, named e2e-<device>.
"""

import base64
import hashlib
import json
import os
import re
import shutil
import sys

PLUGIN_ID = "github-gitless-sync"
PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"]
VAULT_NAME = re.compile(r"^e2e-[a-z0-9]+$")
OBSIDIAN_CONFIG = os.path.expanduser(
    "~/Library/Application Support/obsidian/obsidian.json"
)
# Config files every E2E vault keeps between scenarios, Obsidian rewrites them
# anyway while running
KEPT_CONFIG = {"app.json", "appearance.json", "core-plugins.json", "workspace.json"}


def vault_root(request, name=None):
    name = name or request["vault"]
    if not VAULT_NAME.match(name):
        raise ValueError(f"not an E2E vault: {name}")
    return os.path.join(os.path.expanduser(request["vaultsDir"]), name)


def resolve(root, relative):
    path = os.path.normpath(os.path.join(root, relative))
    if path != root and not path.startswith(root + os.sep):
        raise ValueError(f"path outside the vault: {relative}")
    return path


def git_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def op_write(request):
    path = resolve(vault_root(request), request["path"])
    write_bytes(path, base64.b64decode(request["b64"]))
    stat = os.stat(path)
    return {"size": stat.st_size, "mtime": stat.st_mtime * 1000}


def op_read(request):
    path = resolve(vault_root(request), request["path"])
    if not os.path.isfile(path):
        return {"b64": None}
    with open(path, "rb") as f:
        return {"b64": base64.b64encode(f.read()).decode()}


def op_remove(request):
    path = resolve(vault_root(request), request["path"])
    if os.path.isdir(path):
        shutil.rmtree(path)
    elif os.path.exists(path):
        os.remove(path)
    return {}


def op_list(request):
    root = vault_root(request)
    plugin_dir = os.path.join(root, ".obsidian", "plugins", PLUGIN_ID)
    files = {}
    for folder, _, names in os.walk(root):
        if folder == plugin_dir:
            # The plugin build is big and never interesting
            continue
        for name in names:
            path = os.path.join(folder, name)
            with open(path, "rb") as f:
                files[os.path.relpath(path, root)] = git_sha(f.read())
    return {"files": files}


def op_provision(request):
    """Creates the vaults with the plugin installed and enabled."""
    for name in request["vaults"]:
        root = vault_root(request, name)
        os.makedirs(os.path.join(root, ".obsidian", "plugins", PLUGIN_ID), exist_ok=True)
        community = os.path.join(root, ".obsidian", "community-plugins.json")
        with open(community, "w") as f:
            json.dump([PLUGIN_ID], f)
    return {}


def op_install_plugin(request):
    for name in request["vaults"]:
        plugin_dir = os.path.join(vault_root(request, name), ".obsidian", "plugins", PLUGIN_ID)
        for file_name, b64 in request["files"].items():
            if file_name not in PLUGIN_FILES:
                raise ValueError(f"unexpected plugin file: {file_name}")
            write_bytes(os.path.join(plugin_dir, file_name), base64.b64decode(b64))
    return {}


def op_registration(request):
    """Tells which vaults Obsidian doesn't know about or doesn't open on launch."""
    with open(OBSIDIAN_CONFIG) as f:
        known = {v["path"]: v for v in json.load(f)["vaults"].values()}
    missing = [
        name
        for name in request["vaults"]
        if not known.get(vault_root(request, name), {}).get("open")
    ]
    return {"missing": missing}


def op_register(request):
    """Registers the vaults so Obsidian opens them on launch. Obsidian must be closed."""
    with open(OBSIDIAN_CONFIG) as f:
        config = json.load(f)
    vaults = config["vaults"]
    for name in request["vaults"]:
        root = vault_root(request, name)
        entry = next((v for v in vaults.values() if v["path"] == root), None)
        if entry is None:
            entry = {"path": root, "ts": 0}
            vaults[os.urandom(8).hex()] = entry
        entry["open"] = True
    with open(OBSIDIAN_CONFIG, "w") as f:
        json.dump(config, f)
    return {}


def op_reset(request):
    """
    Empties the vault for a new scenario and writes the plugin settings.
    The plugin must be disabled.
    """
    root = vault_root(request)
    config_dir = os.path.join(root, ".obsidian")
    for name in os.listdir(root):
        if name != ".obsidian":
            op_remove({**request, "path": name})
    for name in os.listdir(config_dir):
        if name not in KEPT_CONFIG and name != "plugins":
            op_remove({**request, "path": f".obsidian/{name}"})
    plugins_dir = os.path.join(config_dir, "plugins")
    for name in os.listdir(plugins_dir):
        if name != PLUGIN_ID:
            shutil.rmtree(os.path.join(plugins_dir, name))
    plugin_dir = os.path.join(plugins_dir, PLUGIN_ID)
    for name in os.listdir(plugin_dir):
        if name not in PLUGIN_FILES:
            op_remove({**request, "path": f".obsidian/plugins/{PLUGIN_ID}/{name}"})
    with open(os.path.join(config_dir, "community-plugins.json"), "w") as f:
        json.dump([PLUGIN_ID], f)
    with open(os.path.join(plugin_dir, "data.json"), "w") as f:
        json.dump(request["settings"], f, indent=2)
    return {}


OPS = {
    "write": op_write,
    "read": op_read,
    "remove": op_remove,
    "list": op_list,
    "provision": op_provision,
    "installPlugin": op_install_plugin,
    "registration": op_registration,
    "register": op_register,
    "reset": op_reset,
}

if __name__ == "__main__":
    request = json.load(sys.stdin)
    try:
        json.dump(OPS[request["op"]](request), sys.stdout)
    except Exception as err:
        # Never echo the request, it might contain the token
        print(f"{request.get('op')}: {type(err).__name__}: {err}", file=sys.stderr)
        sys.exit(1)
