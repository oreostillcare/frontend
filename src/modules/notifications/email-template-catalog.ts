import definitions from "./email-template-definitions.json";

export type EmailTemplateDefinition = (typeof definitions)[number];

export const emailTemplateDefinitions = definitions satisfies readonly EmailTemplateDefinition[];

export function getEmailTemplateDefinition(templateId: string) {
  return emailTemplateDefinitions.find((template) => template.id === templateId);
}
