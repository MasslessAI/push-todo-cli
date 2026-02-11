#!/bin/bash
# Shell wrapper for session-end hook.
# Called by Claude Code's SessionEnd hook to report session_finished to Supabase.
exec node "$(dirname "$0")/session-end.js"
