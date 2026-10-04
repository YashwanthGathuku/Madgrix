"""Completion claim for the frozen-baseline gate. Does not edit the repo."""

import json

print(json.dumps({"type": "agent_message", "text": "Baseline check complete."}))
