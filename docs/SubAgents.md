# Make Astra the boss, not the worker

This fix saves the most. Do not run every task on Astra. Keep it for the parts that genuinely need it. Use it like the smart senior developer it is: let it plan and review, and give the grunt work to cheaper models.

Here is the split:

- **Boring scoping and cleanup:** the cheapest model, such as GPT-5.5.
- **Planning and checklists:** a mid-tier model such as GPT-5.6 Sol or Luna.
- **The hard part at the end, the actual judgment call:** Astra, on medium effort.

> **PAY FOR THE GENIUS ONCE:** GPT-5.5 does the scoping, cleanup and lookups; GPT-5.6 Sol or Luna does planning and checklists; GPT-6 Astra makes the judgment call on medium. A video went from $10 to $1

That way you pay for the genius once, on the 10% of the work that needs it, instead of on every step. This one change is the difference between a video that cost me $10 and one that cost me $1.

**The Codex model picker:** GPT-6 Astra, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5

Do not switch models by hand every time. Set it up once with Codex subagents and let it route itself. There are two ways.

## Option one: write the TOML file yourself

Create a file inside your project's `.codex/agents/` folder. This is the example from the video, `.codex/agents/reviewer.toml`:

```toml
name = "reviewer"
description = "Reviews code for bugs, security risks, and missing tests."
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """
Review code like an owner.
Focus on correctness, security, regressions, and missing tests.
Report concrete findings with file references.
"""
```

## Option two: paste three prompts into Codex

This is much easier. The first two prompts create the subagents. The third tells your Codex agent when to call each of them. Run them in order.

### Create the planner (mid-tier model)

```text
Create a Codex subagent for me. Save it as a TOML file in .codex/agents/ in this project. Name it "planner". Set model = "gpt-5.6-luna" and model_reasoning_effort = "medium". Its job: turn a task into a clear plan and a checklist, break the work into steps, no coding and no final decisions. Write the file, then show me the path and the full contents.
```

### Create the grunt worker (cheap model)

```text
Create another Codex subagent, saved as a TOML file in .codex/agents/. Name it "grunt". Set model = "gpt-5.5" and model_reasoning_effort = "low". Its job: the boring, well-scoped work only, scoping files, cleanup, and lookups, no architecture or design decisions, report back concisely. Write the file, then show me the path and the full contents.
```

### The orchestrator prompt that uses both

```text
You're the orchestrator, running on Astra. For this task, delegate the planning and checklist to my "planner" subagent, and the scoping, cleanup, and lookups to my "grunt" subagent. Wait for both to finish, then do only the final review and the hard judgment call yourself, on medium effort. Show me the plan and which subagent handles what before you start. Task: [describe your task here].
```

Two notes. If the orchestrator does not see the subagents, restart Codex so it loads the new files. And Codex shows a "GPT-5.5 retires on October 14" notice, so swap the grunt's model for a current cheap one when that happens.

Keep going
