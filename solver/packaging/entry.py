"""PyInstaller entry point for the frozen `mayhem-solver` sidecar.

Goes straight through `mayhem_solver.cli.main`, which calls
`multiprocessing.freeze_support()` first so spawned solve workers (which re-exec this
binary) are dispatched to their target instead of re-running the CLI.
"""

import sys

from mayhem_solver.cli import main

if __name__ == "__main__":
    sys.exit(main())
