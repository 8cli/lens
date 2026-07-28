"""CLI entry point for Aperture.

Usage:
    python -m aperture
    python -m aperture --port 3000
    python -m aperture --socket /var/run/aperture.sock
"""

import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="Aperture — AI Protocol Translator")
    parser.add_argument(
        "--host",
        default=os.environ.get("APERTURE_HOST", "0.0.0.0"),
        help="Bind address (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("APERTURE_PORT", "8080")),
        help="Bind port (default: 8080)",
    )
    parser.add_argument(
        "--socket",
        default=os.environ.get("APERTURE_UNIX_SOCKET", ""),
        help="Unix socket path (overrides host:port)",
    )
    args = parser.parse_args()

    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.isfile(env_path):
        try:
            from dotenv import load_dotenv
            load_dotenv(env_path)
        except ImportError:
            pass

    from aiohttp import web
    from .index import create_app

    app = create_app()

    if args.socket:
        print(f"Aperture starting on unix://{args.socket}", file=sys.stderr)
        web.run_app(app, path=args.socket)
    else:
        print(f"Aperture starting on http://{args.host}:{args.port}", file=sys.stderr)
        web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
