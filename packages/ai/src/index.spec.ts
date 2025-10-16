import { expect, it } from 'vitest';
import { AIClient, OpenAIClient } from './shared/client';
import { AIThread } from './shared/thread';

it.skip('should create an AIClient and send it a message', async () => {
  console.log(process.env.OPENAI_API_KEY);
  const client = await OpenAIClient.create({
    apiKey: process.env.OPENAI_API_KEY!,
  });
  const result = await client.message('What is the capital of France?');
  expect(result.toLowerCase()).toContain('paris');
}, 30000);

it.skip('should create an AIThread and ask it a question', async () => {
  const options = {
    ai: {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY!,
    },
    prompt: 'What is the capital of France?',
  };

  const _ai = await AIClient.create(options.ai);

  // lets talk about it
  const thread = await AIThread.create({
    ai: options.ai,
  });

  await thread.addSystem('You are a helpful assistant.'); // Add the system message

  await thread.addReference('Meeting Minutes', minutes);

  await thread.add({
    role: 'user',
    content:
      'Summarize the key decisions from the meeting and how they impact the budget.',
  });

  const response = await thread.do('Write a short summary.'); // The prompt here is now used *in addition to* the history.

  // const response = await thread.do({
  //   prompt: 'Write an article about what happened in the last meeting',
  //   responseFormat: 'html',
  // });
  // console.log({ response });

  console.log(response);
}, 30000);

it('should support creating Anthropic client via AIClient.create', async () => {
  const client = await AIClient.create({
    type: 'anthropic',
    apiKey: 'test-key',
  } as any);
  expect(client).toBeDefined();
  expect(client.options.type).toBe('anthropic');
});

it('should support creating Gemini client via AIClient.create', async () => {
  const client = await AIClient.create({
    type: 'gemini',
    apiKey: 'test-key',
  } as any);
  expect(client).toBeDefined();
  expect(client.options.type).toBe('gemini');
});

it('should support creating Bedrock client via AIClient.create', async () => {
  const client = await AIClient.create({
    type: 'bedrock',
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret',
    },
  } as any);
  expect(client).toBeDefined();
  expect(client.options.type).toBe('bedrock');
});

it('should support creating HuggingFace client via AIClient.create', async () => {
  const client = await AIClient.create({
    type: 'huggingface',
    apiToken: 'test-token',
    model: 'microsoft/DialoGPT-medium',
  } as any);
  expect(client).toBeDefined();
  expect(client.options.type).toBe('huggingface');
});

it('should throw helpful error for unsupported provider type', async () => {
  await expect(
    AIClient.create({
      type: 'invalid-provider' as any,
      apiKey: 'test-key',
    }),
  ).rejects.toThrow('Unsupported AI provider type');
});

it('should list all supported providers in error message', async () => {
  try {
    await AIClient.create({
      type: 'invalid-provider' as any,
      apiKey: 'test-key',
    });
    // Should not reach here
    expect(true).toBe(false);
  } catch (error: any) {
    expect(error.context.supportedTypes).toContain('openai');
    expect(error.context.supportedTypes).toContain('anthropic');
    expect(error.context.supportedTypes).toContain('gemini');
    expect(error.context.supportedTypes).toContain('bedrock');
    expect(error.context.supportedTypes).toContain('huggingface');
  }
});

const minutes =
  'V, 1/ 7\n' +
  'NRL — un ON\n' +
  'Town\n' +
  'Minutes of the Regular of the Council of the Town of Bentley November 26, 2024\n' +
  'Date and Place\n' +
  'In Attendance\n' +
  'Call to Order\n' +
  'Indigenous Acknowledgement\n' +
  'Agenda\n' +
  'Minutes of the Regular Meeting of the Council of the Town of Bentley held Tuesday, November 26, 2024, at 6:30 p.m., in the Bentley Municipal Office\n' +
  'Mayor Greg Rathjen Deputy Mayor Valiquette Councillor Eastman Councillor Hansen Councillor Grimsdale CAO, Marc Fortais\n' +
  'Mayor Rathjen called the regular council meeting to order at 6:30pm\n' +
  '“We acknowledge that we are meeting on Treaty 6 Territory and Home of Metis Nation Region 3, on land that is part of a historic agreement involving mutuality and respect. We recognize all the many First Nations, Metis, Inuit, and non-First Nations whose footsteps have marked these lands.”\n' +
  'Read by Mayor Rathjen\n' +
  'Motion 228/2024 Moved by Councillor Hansen, “THAT the agenda of the November 26, 2024, regular meeting of council be amended to include the following items as other business:\n' +
  '1) Gull Lake East Trail – letter of support to Lacombe County 2) Local Sustainability Grant Application\n' +
  'Carried\n' +
  'Motion 229/2024 Moved by Councillor Grimsdale, “THAT the‘amended agenda of the October 26, 2024, regular meeting of council be accepted.”\n' +
  'Carried\n' +
  'Regular Council Meeting Minutes November 26, 2024\n' +
  'Previous Minutes\n' +
  'Financial\n' +
  'New Business\n' +
  'Motion 23012024 Moved by Deputy Mayor Valiquette, “THAT the minutes of the October 22, 2024, Regular Meeting of Council be accepted.”\n' +
  'Carried\n' +
  'Motion 231/2024 Moved by Councillor Hansen, “THAT the minutes of the October 22, 2024, Organizational Meeting of Council be accepted.”\n' +
  'Carried\n' +
  'a) Prepaid Cheque Listing – Cheques No. 20240828 to 20240913\n' +
  'Motion 232/2024 Moved by Councillor Eastman, “THAT Cheques No. 20240778 to 20240827 be received for information.”\n' +
  'Carried\n' +
  'a) Delegation – Lacombe County Tourism – 2024 Annual Report\n' +
  'Motion 233/2024 Moved by Councillor Eastman, “THAT the report presented by Lacombe County Tourism – 2024 Annual Report be accepted as information: AND\n' +
  'THAT administration be directed to include funding for 2025 to support Lacombe Tourism in the preliminary budget for consideration by Mayor and Council.\n' +
  'Carried\n' +
  'b) Land Sale – Lot 41, Block 1, Plan 2320333 Motion 234/2024 Moved by Councillor Grimsdale, “THAT Mayor and Council approve the sale of 5604 48A Street (Lot 41, Block 1, Plan 2320333) located in the Tonw of Bentley, within the Sunset Heights Subdivision to Shane David Imber and Diane Marie Imber for the amount of $62,000\n' +
  '(including any applicable GST) subject to the following terms and conditions: Excepting thereout aII mines and minerals\n' +
  'Purchaser Shane David Imber Diane Marie Imber\n' +
  'Sale Price The Sale price is $62,000 including any applicable GST. But does not include any development costs or permits.\n' +
  'l\n' +
  'Regular Council Meeting Minutes November 26, 2024\n' +
  'Environmental Considerations The subject property is sold on an ”as is – where is” basis.\n' +
  'Fees and Disbursements The purchaser shall be responsible for all legal and registration fees associated with the transaction.\n' +
  'Vendor Conditions Subject to approval of this agreement by Town of Bentley Council before 9:00pm November 27, 2024, Seller will not provide an RPR\n' +
  'Purchaser Conditions Financing condition before 9:00pm November 29, 2024\n' +
  'Completion Day Contract completed, the purchase price fully paid and vacant possession given to the buyer at 12 noon on January 6, 2025 (this was amended form the original proposed date of January 2, 2025)"\n' +
  'Carried\n' +
  'c) Lacombe County – RC1 Grant Request $675,000 – Arena Slab Replacement\n' +
  'Motion 235/2024 Moved by Councillor Grimsdale, “THAT Mayor and Council, authorize CAO Marc Fortais to submit an RC1 grant application to Lacombe County to request funding of up to $675,000 (the maximum amount to fund 50% of the project costs for completion and replacement of‘ the Bentley Arena Slab, boards and glass; AND\n' +
  'The project to be completed in the 2025 budget year.”\n' +
  'Carried\n' +
  'd) Asset Management Phase III e Stormwater Plan o Wastewater Plan * Transportation Plan\n' +
  'Motion 236/2024 Moved by Deputy Mayor Valiquette, “THAT Mayor and Council approve the asset management plan reports prepared by Stantec for Stormwater, Wastewater, and Transportation; AND\n' +
  'I\n' +
  'Regular Council Meeting Minutes November 26, 2024\n' +
  'Break\n' +
  'Correspondence\n' +
  'Other Business\n' +
  'THAT Administration be directed to provide Mayor and Council with a reasonable rate strategy for utilities as a part of the 2025 Preliminary Budget approval process to ensure the establishment of a reasonable amount of reserve that does not create an excessive burden for the local rate payer.”\n' +
  'Carried\n' +
  'Councillor Grimsdale requested a break prior to reviewing the 3™ Quarter Financial Report\n' +
  'Motion 237/2024 Moved by Councillor Grimsdale, “THAT Mayor and Council take a short break of 10 minutes at 7:26pm, prior to reviewing the 3 Quarter Financial Report to be presented by the CAO.”\n' +
  'Carried\n' +
  'Mayor Rathjen called the meeting to order at 7:34 pm concluding the break.\n' +
  'e) 3” Quarter Financial Report Motion 238/2024 Moved by Councillor Eastman, “THAT the 3 Quarter Financial Report and presentation be accepted as information by Mayor and Council.\n' +
  'Carried\n' +
  'a) Lacombe County Council Highlights October 24, 2024 b) Lacombe County Council Highlights November 14, 2024\n' +
  'Motion 239/2024 Moved by Deputy Mayor Valiquette, “THAT correspondence item a to b be accepted as information.”\n' +
  'Carried\n' +
  'a) Gull Lake East Trail – Letter of Support to Lacombe County Motion 240/2024 Moved by Councillor Hansen, “THAT Mayor and Council provide a letter of support to Lacombe County for their grant application to the Alberta Strategic Transportation Infrastructure Program for the purpose of paving a 5km trail on the east side of Gull Lake.”\n' +
  'Carried\n' +
  'Regular Council Meeting Minutes November 26, 2024\n' +
  'b) Local Sustainability Grant Application – Town of Bentley Motion 241//2024 Moved by Councillor Eastman, “THAT the CAO be directed to apply to the Local Growth and Sustainability Grant program, under the sustainability component to support a sewer main replacement along 48” Ave in the 2026 budgetary year.”\n' +
  'Carried\n' +
  'Council Reports\n' +
  'a) Mayor Rathjen b) Deputy Mayor Valiquette c) Councillor Grimsdale d) Councillor Eastman e) Councillor Hansen\n' +
  'Motion 242/2024 Moved by Councillor Grimsdale, “THAT the council reports for October be accepted as information.”\n' +
  'Carried\n' +
  'Adjournment\n' +
  'Mayor Rathjen adjourned the meeting at 8:20pm\n' +
  'N ‘ pe. Mayor Greg Rathjen CAO Marc rtais\n' +
  '_— ee —— –— Regular Council Meeting Minutes November 26, 2024';
