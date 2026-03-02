# Plugin Skill Patterns

This document covers skill development specifically within Claude Code plugins.

## Skill Location in Plugins

Plugin skills live in the plugin's `skills/` directory:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json
├── commands/
├── agents/
└── skills/
    └── my-skill/
        ├── SKILL.md
        ├── references/
        ├── examples/
        └── scripts/
```

## Auto-Discovery

Claude Code automatically discovers skills within plugins:
- Scans `skills/` directory for subdirectories containing `SKILL.md`
- Loads skill metadata (name + description) always into context
- Loads SKILL.md body when skill triggers based on user request
- Loads references/examples when Claude determines they're needed

No registration or configuration required — just create the directory structure.

## No Packaging Needed

Plugin skills are distributed as part of the plugin. Users get skills when they install the plugin. Unlike standalone skills, there's no need to run `package_skill.py` or create ZIP files.

## Creating a Plugin Skill

```bash
# Create the skill directory within your plugin
mkdir -p my-plugin/skills/skill-name/{references,examples,scripts}
touch my-plugin/skills/skill-name/SKILL.md
```

Write the SKILL.md following the standard skill creation process (see main SKILL.md).

## Testing Plugin Skills

Test skills by loading the plugin locally:

```bash
# Launch Claude Code with local plugin
cc --plugin-dir /path/to/my-plugin

# Then ask questions that should trigger the skill
# Verify skill loads correctly and provides useful guidance
```

## Plugin-Dev Examples

The `plugin-dev` plugin itself contains excellent examples of well-crafted skills:

### hook-development
- Excellent trigger phrases: "create a hook", "add a PreToolUse hook", etc.
- Lean SKILL.md (~1,651 words)
- 3 references/ files for detailed content
- 3 examples/ of working hooks
- 3 scripts/ utilities

### agent-development
- Strong triggers: "create an agent", "agent frontmatter", etc.
- Focused SKILL.md (~1,438 words)
- References include the AI generation prompt from Claude Code
- Complete agent examples

### command-development
- Clear critical concepts
- Good references structure

### plugin-settings
- Specific triggers: "plugin settings", ".local.md files", "YAML frontmatter"
- References show real implementations (multi-agent-swarm, ralph-loop)
- Working parsing scripts

### mcp-integration
- Comprehensive references
- Multiple reference files for different MCP patterns

### plugin-structure
- Good organization
- Covers the complete plugin anatomy

Each demonstrates progressive disclosure and strong triggering. Study them as templates when building new plugin skills.

## Plugin vs Standalone Skills

| Aspect | Plugin Skill | Standalone Skill |
|--------|-------------|-----------------|
| Location | `plugin/skills/skill-name/` | `~/.claude/skills/skill-name/` |
| Distribution | With plugin install | Manual or symlink |
| Discovery | Auto from plugin scan | Auto from skills/ scan |
| Packaging | Not needed | Optional via `package_skill.py` |
| Updates | Plugin marketplace | Manual |
| Command prefix | `plugin-name:skill-name` | `skill-name` |

## Plugin Skill Validation

After creating a plugin skill:

1. **Check structure**: Skill directory in `plugin-name/skills/skill-name/`
2. **Validate SKILL.md**: Has frontmatter with name and description
3. **Check trigger phrases**: Description includes specific user queries
4. **Verify writing style**: Body uses imperative form
5. **Test progressive disclosure**: SKILL.md is lean, detailed content in references/
6. **Check references**: All referenced files exist
7. **Validate examples**: Examples are complete and correct
8. **Test scripts**: Scripts are executable and work correctly

Use the **skill-reviewer agent** from plugin-dev:
```
Ask: "Review my skill and check if it follows best practices"
```
