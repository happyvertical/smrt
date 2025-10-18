# @smrt/core

## Classes

- [AIError](classes/AIError.md)
- [APIGenerator](classes/APIGenerator.md)
- [CLIGenerator](classes/CLIGenerator.md)
- [ConfigurationError](classes/ConfigurationError.md)
- [DatabaseError](classes/DatabaseError.md)
- [ErrorUtils](classes/ErrorUtils.md)
- [Field](classes/Field.md)
- [FilesystemError](classes/FilesystemError.md)
- [ManifestGenerator](classes/ManifestGenerator.md)
- [MCPGenerator](classes/MCPGenerator.md)
- [MetricsAdapter](classes/MetricsAdapter.md)
- [NetworkError](classes/NetworkError.md)
- [ObjectRegistry](classes/ObjectRegistry.md)
- [Pleb](classes/Pleb.md)
- [PubSubAdapter](classes/PubSubAdapter.md)
- [RuntimeError](classes/RuntimeError.md)
- [SignalBus](classes/SignalBus.md)
- [SignalSanitizer](classes/SignalSanitizer.md)
- [SmrtClass](classes/SmrtClass.md)
- [SmrtCollection](classes/SmrtCollection.md)
- [SmrtError](classes/SmrtError.md)
- [SmrtObject](classes/SmrtObject.md)
- [ValidationError](classes/ValidationError.md)
- [ValidationReport](classes/ValidationReport.md)
- [ValidationUtils](classes/ValidationUtils.md)

## Interfaces

- [AiConfig](interfaces/AiConfig.md)
- [APIConfig](interfaces/APIConfig.md)
- [APIContext](interfaces/APIContext.md)
- [CLIConfig](interfaces/CLIConfig.md)
- [CLIContext](interfaces/CLIContext.md)
- [DiscoveryStrategy](interfaces/DiscoveryStrategy.md)
- [FieldOptions](interfaces/FieldOptions.md)
- [ForgetOptions](interfaces/ForgetOptions.md)
- [ForgetScopeOptions](interfaces/ForgetScopeOptions.md)
- [GlobalSignalConfig](interfaces/GlobalSignalConfig.md)
- [MCPConfig](interfaces/MCPConfig.md)
- [MCPContext](interfaces/MCPContext.md)
- [MCPRequest](interfaces/MCPRequest.md)
- [MCPResponse](interfaces/MCPResponse.md)
- [MCPTool](interfaces/MCPTool.md)
- [MethodMetrics](interfaces/MethodMetrics.md)
- [MetricsConfig](interfaces/MetricsConfig.md)
- [MetricsSnapshot](interfaces/MetricsSnapshot.md)
- [NoteMetadata](interfaces/NoteMetadata.md)
- [NoteOptions](interfaces/NoteOptions.md)
- [NumericFieldOptions](interfaces/NumericFieldOptions.md)
- [OpenAPIConfig](interfaces/OpenAPIConfig.md)
- [ParsedArgs](interfaces/ParsedArgs.md)
- [PlebOptions](interfaces/PlebOptions.md)
- [PubSubConfig](interfaces/PubSubConfig.md)
- [RecallAllOptions](interfaces/RecallAllOptions.md)
- [RecallOptions](interfaces/RecallOptions.md)
- [RelationshipFieldOptions](interfaces/RelationshipFieldOptions.md)
- [RelationshipMetadata](interfaces/RelationshipMetadata.md)
- [RestServerConfig](interfaces/RestServerConfig.md)
- [SanitizationConfig](interfaces/SanitizationConfig.md)
- [SmartObjectConfig](interfaces/SmartObjectConfig.md)
- [SmartObjectDefinition](interfaces/SmartObjectDefinition.md)
- [SmartObjectManifest](interfaces/SmartObjectManifest.md)
- [SmrtClassOptions](interfaces/SmrtClassOptions.md)
- [SmrtClientOptions](interfaces/SmrtClientOptions.md)
- [SmrtCollectionOptions](interfaces/SmrtCollectionOptions.md)
- [SmrtObjectOptions](interfaces/SmrtObjectOptions.md)
- [SmrtServerOptions](interfaces/SmrtServerOptions.md)
- [Subscription](interfaces/Subscription.md)
- [SystemTableConfig](interfaces/SystemTableConfig.md)
- [TextFieldOptions](interfaces/TextFieldOptions.md)
- [ToolCall](interfaces/ToolCall.md)
- [ToolCallResult](interfaces/ToolCallResult.md)

## Type Aliases

- [CLICommand](type-aliases/CLICommand.md)
- [RelationshipType](type-aliases/RelationshipType.md)
- [Signal](type-aliases/Signal.md)
- [SignalFilter](type-aliases/SignalFilter.md)
- [SignalSubscriber](type-aliases/SignalSubscriber.md)

## Variables

- [ALL\_SYSTEM\_TABLES](variables/ALL_SYSTEM_TABLES.md)
- [CREATE\_SMRT\_CONTEXTS\_TABLE](variables/CREATE_SMRT_CONTEXTS_TABLE.md)
- [CREATE\_SMRT\_MIGRATIONS\_TABLE](variables/CREATE_SMRT_MIGRATIONS_TABLE.md)
- [CREATE\_SMRT\_REGISTRY\_TABLE](variables/CREATE_SMRT_REGISTRY_TABLE.md)
- [CREATE\_SMRT\_SIGNALS\_TABLE](variables/CREATE_SMRT_SIGNALS_TABLE.md)
- [manifest](variables/manifest.md)
- [SMRT\_SCHEMA\_VERSION](variables/SMRT_SCHEMA_VERSION.md)

## Functions

- [boolean](functions/boolean.md)
- [config](functions/config.md)
- [convertTypeToJsonSchema](functions/convertTypeToJsonSchema.md)
- [createMCPServer](functions/createMCPServer.md)
- [createRestServer](functions/createRestServer.md)
- [createSmrtClient](functions/createSmrtClient.md)
- [createSmrtServer](functions/createSmrtServer.md)
- [datetime](functions/datetime.md)
- [decimal](functions/decimal.md)
- [executeToolCall](functions/executeToolCall.md)
- [executeToolCalls](functions/executeToolCalls.md)
- [foreignKey](functions/foreignKey.md)
- [formatToolResults](functions/formatToolResults.md)
- [generateOpenAPISpec](functions/generateOpenAPISpec.md)
- [generateToolFromMethod](functions/generateToolFromMethod.md)
- [generateToolManifest](functions/generateToolManifest.md)
- [getManifest](functions/getManifest.md)
- [integer](functions/integer.md)
- [json](functions/json.md)
- [main](functions/main.md)
- [manyToMany](functions/manyToMany.md)
- [oneToMany](functions/oneToMany.md)
- [setupSwaggerUI](functions/setupSwaggerUI.md)
- [shouldIncludeMethod](functions/shouldIncludeMethod.md)
- [smrt](functions/smrt.md)
- [smrtPlugin](functions/smrtPlugin.md)
- [startRestServer](functions/startRestServer.md)
- [text](functions/text.md)
- [validateToolCall](functions/validateToolCall.md)

## References

### SignalAdapter

Renames and re-exports [Signal](type-aliases/Signal.md)

***

### SignalType

Renames and re-exports [Signal](type-aliases/Signal.md)

***

### smrtRegistry

Renames and re-exports [smrt](functions/smrt.md)
