## Overview

The assistant is a chat panel that opens from a button in the app's top bar. It
sees the page you are on, so you can ask about what is in front of you and get
an answer without leaving it.

You can keep several conversations and come back to them later. The assistant
only reaches the data and actions the app owner allows, and it works with your
own permissions: it cannot show you anything you could not open yourself.

## Tasks

### Ask a question

1. Choose the assistant button in the top bar to open the panel.
2. Type your question and send it.
3. Read the reply as it arrives. Open the panel again from any page to carry on.

### Start a new conversation

1. Open the panel and choose the conversation list.
2. Start a new conversation, or pick an earlier one to carry on.

### Approve a change

When the assistant proposes a change, it shows what will happen and waits.

1. Read the proposed change.
2. Confirm it to go ahead, or reject it. Nothing changes until you confirm.

### Choose a model

If the app offers more than one model, pick one from the list in the panel
before you send a message.

## What the app owner sets up

- A model. Hosted models need the service key their provider issues, stored as
  a secret in the app (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or
  `GEMINI_API_KEY`); only the key for the model the app uses is needed. Models
  that run in the browser need no key.
- The tools the assistant may use. It is offered nothing unless the app lists
  it, so an empty list means conversation only.
- Optionally, report tools. An app can let the assistant draft a report from a
  request, preview it, and save it only after a person approves that exact
  report.
