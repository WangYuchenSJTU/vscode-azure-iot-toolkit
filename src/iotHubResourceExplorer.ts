// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

"use strict";
import { ResourceManagementClient, ResourceModels, SubscriptionClient, SubscriptionModels } from "azure-arm-resource";
import IoTHubClient = require("azure-arm-iothub");
import * as clipboardy from "clipboardy";
import * as vscode from "vscode";
import { IotHubDescription } from "../node_modules/azure-arm-iothub/lib/models";
import { AzureAccount, AzureLoginStatus, AzureResourceFilter, AzureSession } from "./azure-account.api";
import { BaseExplorer } from "./baseExplorer";
import { Constants } from "./constants";
import { DeviceItem } from "./Model/DeviceItem";
import { IotHubItem } from "./Model/IotHubItem";
import { LocationItem } from "./Model/LocationItem";
import { ResourceGroupItem } from "./Model/ResourceGroupItem";
import { SubscriptionItem } from "./Model/SubscriptionItem";
import { TelemetryClient } from "./telemetryClient";
import { Utility } from "./utility";

export class IoTHubResourceExplorer extends BaseExplorer {
    private readonly accountApi: AzureAccount;

    constructor(outputChannel: vscode.OutputChannel) {
        super(outputChannel);
        this.accountApi = vscode.extensions.getExtension<AzureAccount>("ms-vscode.azure-account")!.exports;
    }

    public async createIoTHub(outputChannel: vscode.OutputChannel = this._outputChannel): Promise<IotHubDescription> {
        TelemetryClient.sendEvent(Constants.IoTHubAICreateStartEvent);
        if (!(await this.waitForLogin())) {
            return;
        }

        const subscriptionItem = await vscode.window.showQuickPick(
            this.loadSubscriptionItems(this.accountApi),
            { placeHolder: "Select a subscription to create your IoT Hub in...", ignoreFocusOut: true },
        );
        if (!subscriptionItem) {
            return;
        }
        outputChannel.show();
        outputChannel.appendLine(`Subscription selected: ${subscriptionItem.label}`);

        const resourceGroupItem = await this.getOrCreateResourceGroup(subscriptionItem);
        if (!resourceGroupItem) {
            return;
        }
        outputChannel.appendLine(`Resource Group selected: ${resourceGroupItem.label}`);

        const locationItem = await vscode.window.showQuickPick(
            this.getLocationItems(subscriptionItem),
            { placeHolder: "Select a location to create your IoT Hub in...", ignoreFocusOut: true },
        );
        if (!locationItem) {
            return;
        }
        outputChannel.appendLine(`Location selected: ${locationItem.label}`);

        const skuMap = {
            "F1 Free": "F1",
            "S1 Standard": "S1",
            "S2 Standard": "S2",
            "S3 Standard": "S3",
        };
        const sku = await vscode.window.showQuickPick(
            Object.keys(skuMap),
            { placeHolder: "Select pricing and scale tier for your IoT Hub...", ignoreFocusOut: true },
        );
        if (!sku) {
            return;
        }
        outputChannel.appendLine(`Pricing and scale tier selected: ${sku}`);

        const name = await this.getIoTHubName(subscriptionItem);
        if (!name) {
            return;
        }

        return vscode.window.withProgress({
            title: `Creating IoT Hub '${name}'`,
            location: vscode.ProgressLocation.Window,
        }, async (progress) => {
            outputChannel.appendLine(`Creating IoT Hub: ${name}`);
            const intervalID = setInterval(() => {
                outputChannel.append(".");
            }, 1000);

            const { session, subscription } = subscriptionItem;
            const client = new IoTHubClient(session.credentials, subscription.subscriptionId);
            const iotHubCreateParams = {
                location: locationItem.location.name,
                subscriptionid: subscription.subscriptionId,
                resourcegroup: resourceGroupItem.resourceGroup.name,
                sku:
                    {
                        name: skuMap[sku],
                        capacity: 1,
                    },
            };
            return client.iotHubResource.createOrUpdate(resourceGroupItem.resourceGroup.name, name, iotHubCreateParams)
                .then(async (iotHubDescription) => {
                    clearInterval(intervalID);
                    outputChannel.appendLine("");
                    const newIotHubConnectionString = await this.getIoTHubConnectionString(subscriptionItem, iotHubDescription);
                    outputChannel.appendLine(`IoT Hub '${name}' is created.`);
                    await this.updateIoTHubConnectionString(newIotHubConnectionString);
                    (iotHubDescription as any).iotHubConnectionString = newIotHubConnectionString;
                    TelemetryClient.sendEvent(Constants.IoTHubAICreateDoneEvent, { Result: "Success" }, newIotHubConnectionString);
                    return iotHubDescription;
                })
                .catch((err) => {
                    clearInterval(intervalID);
                    outputChannel.appendLine("");
                    let errorMessage: string;
                    if (err.message) {
                        errorMessage = err.message;
                    } else if (err.body && err.body.message) {
                        errorMessage = err.body.message;
                    } else {
                        errorMessage = "Error occurred when creating IoT Hub.";
                    }
                    outputChannel.appendLine(errorMessage);
                    TelemetryClient.sendEvent(Constants.IoTHubAICreateDoneEvent, { Result: "Fail", Message: errorMessage });
                    return Promise.reject(err);
                });
        });
    }

    public async selectIoTHub(outputChannel: vscode.OutputChannel = this._outputChannel): Promise<IotHubDescription> {
        TelemetryClient.sendEvent("General.Select.IoTHub.Start");
        if (!(await this.waitForLogin())) {
            return;
        }
        TelemetryClient.sendEvent("General.Select.Subscription.Start");
        const subscriptionItems = this.loadSubscriptionItems(this.accountApi);
        const subscriptionItem = await vscode.window.showQuickPick(subscriptionItems, { placeHolder: "Select Subscription", ignoreFocusOut: true });
        if (subscriptionItem) {
            TelemetryClient.sendEvent("General.Select.Subscription.Done");
            outputChannel.show();
            outputChannel.appendLine(`Subscription selected: ${subscriptionItem.label}`);
            const iotHubItem = await this.selectIoTHubItem(subscriptionItem);
            if (iotHubItem) {
                outputChannel.appendLine(`IoT Hub selected: ${iotHubItem.label}`);
                const iotHubConnectionString = await this.getIoTHubConnectionString(subscriptionItem, iotHubItem.iotHubDescription);
                await this.updateIoTHubConnectionString(iotHubConnectionString);
                (iotHubItem.iotHubDescription as any).iotHubConnectionString = iotHubConnectionString;
                TelemetryClient.sendEvent("AZ.Select.IoTHub.Done", undefined, iotHubConnectionString);
                return iotHubItem.iotHubDescription;
            }
        }
    }

    public copyIoTHubConnectionString() {
        TelemetryClient.sendEvent("AZ.Copy.IotHubConnectionString");
        const iotHubConnectionString = Utility.getConnectionStringWithId(Constants.IotHubConnectionStringKey);
        if (iotHubConnectionString) {
            clipboardy.write(iotHubConnectionString);
        }
    }

    public async copyDeviceConnectionString(deviceItem: DeviceItem) {
        deviceItem = await Utility.getInputDevice(deviceItem, "AZ.Copy.DeviceConnectionString");
        if (deviceItem && deviceItem.connectionString) {
            clipboardy.write(deviceItem.connectionString);
        }
    }

    public async generateSasTokenForIotHub() {
        TelemetryClient.sendEvent("AZ.Generate.SasToken.Service");
        const iotHubConnectionString = await Utility.getConnectionString(Constants.IotHubConnectionStringKey, Constants.IotHubConnectionStringTitle);
        if (iotHubConnectionString) {
            this.generateSasToken(Utility.generateSasTokenForService, iotHubConnectionString, "IoT Hub");
        }
    }

    public async generateSasTokenForDevice(deviceItem: DeviceItem) {
        deviceItem = await Utility.getInputDevice(deviceItem, "AZ.Generate.SasToken.Device");
        if (deviceItem && deviceItem.connectionString) {
            this.generateSasToken(Utility.generateSasTokenForDevice, deviceItem.connectionString, deviceItem.deviceId);
        }
    }

    private async generateSasToken(sasTokenFunction: (connectionString: string, expiryInHours: number) => string, connectionString: string, target: string) {
        const expiryInHours = await vscode.window.showInputBox({ prompt: `Enter expiration time (hours)`, ignoreFocusOut: true });
        if (expiryInHours && !isNaN(parseFloat(expiryInHours))) {
            const sasToken = sasTokenFunction(connectionString, parseFloat(expiryInHours));
            clipboardy.write(sasToken);
            this._outputChannel.show();
            this.outputLine("SASToken", `SAS token for [${target}] is generated and copied to clipboard:`);
            this._outputChannel.appendLine(sasToken);
        }
    }

    private async waitForLogin(): Promise<boolean> {
        if (!(await this.accountApi.waitForLogin())) {
            TelemetryClient.sendEvent("General.AskForAzureLogin");
            await vscode.commands.executeCommand("azure-account.askForLogin");
            return this.accountApi.waitForLogin();
        } else {
            return true;
        }
    }

    private async loadSubscriptionItems(api: AzureAccount) {
        await api.waitForFilters();
        const subscriptionItems: SubscriptionItem[] = api.filters.map((filter) => new SubscriptionItem(filter.subscription, filter.session));
        TelemetryClient.sendEvent("General.Load.Subscription", { SubscriptionCount: subscriptionItems.length.toString() });
        return subscriptionItems;
    }

    private async loadIoTHubItems(subscriptionItem: SubscriptionItem) {
        const iotHubItems: IotHubItem[] = [];
        const { session, subscription } = subscriptionItem;
        const client = new IoTHubClient(session.credentials, subscription.subscriptionId);
        const iotHubs = await client.iotHubResource.listBySubscription();
        iotHubItems.push(...iotHubs.map((iotHub) => new IotHubItem(iotHub)));
        iotHubItems.sort((a, b) => a.label.localeCompare(b.label));
        TelemetryClient.sendEvent("General.Load.IoTHub", { IoTHubCount: iotHubItems.length.toString() });
        return iotHubItems;
    }

    private async selectIoTHubItem(subscriptionItem: SubscriptionItem): Promise<IotHubItem> {
        const iotHubItems = this.loadIoTHubItems(subscriptionItem);
        let retryCount = 3;
        let iotHubItem;
        // Sometimes showQuickPick of VS Code would return 'undefined' and disappear immediately without waiting for Promise is resolved
        // Workaround here to add retry logic
        do {
            const start = new Date().getTime();
            iotHubItem = await vscode.window.showQuickPick(iotHubItems, { placeHolder: "Select IoT Hub", ignoreFocusOut: true });
            // If user press 'Esc', the showQuickPick would also return 'undefined'
            // So we will retry only if showQuickPick retrun 'undefined' within 500 ms (Mostly not triggered by user pressing 'Esc')
            if (iotHubItem === undefined && (new Date().getTime() - start < 500)) {
                retryCount--;
            } else {
                return iotHubItem;
            }
        } while (retryCount > 0);
        return iotHubItem;
    }

    private async updateIoTHubConnectionString(iotHubConnectionString: string) {
        const config = Utility.getConfiguration();
        await config.update(Constants.IotHubConnectionStringKey, iotHubConnectionString, true);
        vscode.commands.executeCommand("azure-iot-toolkit.refresh");
    }

    private async getIoTHubConnectionString(subscriptionItem: SubscriptionItem, iotHubDescription: IotHubDescription) {
        const { session, subscription } = subscriptionItem;
        const client = new IoTHubClient(session.credentials, subscription.subscriptionId);
        return client.iotHubResource.getKeysForKeyName(iotHubDescription.resourcegroup, iotHubDescription.name, "iothubowner").then((result) => {
            return `HostName=${iotHubDescription.properties.hostName};SharedAccessKeyName=${result.keyName};SharedAccessKey=${result.primaryKey}`;
        });
    }

    private async getOrCreateResourceGroup(subscriptionItem: SubscriptionItem): Promise<ResourceGroupItem> {
        const pick = await vscode.window.showQuickPick(
            this.getResourceGroupItems(subscriptionItem),
            { placeHolder: "Select a resource group to create your IoT Hub in...", ignoreFocusOut: true },
        );

        if (pick) {
            if (pick instanceof (ResourceGroupItem)) {
                return pick;
            } else {
                const newGroup = await this.createResourceGroup(subscriptionItem);
                if (newGroup) {
                    return new ResourceGroupItem(newGroup);
                }
            }
        }
        return null;
    }

    private async getResourceGroupItems(subscriptionItem: SubscriptionItem): Promise<vscode.QuickPickItem[]> {
        const resourceManagementClient = new ResourceManagementClient(subscriptionItem.session.credentials, subscriptionItem.subscription.subscriptionId);
        const resourceGroups = await resourceManagementClient.resourceGroups.list();
        let resourceGroupItems: vscode.QuickPickItem[] = [{
            label: "$(plus) Create Resource Group",
            description: null,
        }];
        return resourceGroupItems.concat(resourceGroups.map((resourceGroup) => new ResourceGroupItem(resourceGroup)));
    }

    private async getLocationItems(subscriptionItem: SubscriptionItem): Promise<LocationItem[]> {
        const subscriptionClient = new SubscriptionClient(subscriptionItem.session.credentials);
        const locations = await subscriptionClient.subscriptions.listLocations(subscriptionItem.subscription.subscriptionId);
        return locations.map((location) => new LocationItem(location));
    }

    private async getIoTHubName(subscriptionItem: SubscriptionItem): Promise<string> {
        const client = new IoTHubClient(subscriptionItem.session.credentials, subscriptionItem.subscription.subscriptionId);

        while (true) {
            const accountName = await vscode.window.showInputBox({
                placeHolder: "IoT Hub name",
                prompt: "Provide IoT Hub name",
                validateInput: this.validateIoTHubName,
                ignoreFocusOut: true,
            });

            if (!accountName) {
                // If the user escaped the input box, exit the while loop
                break;
            }

            try {
                const nameAvailable = (await client.iotHubResource.checkNameAvailability(accountName)).nameAvailable;
                if (nameAvailable) {
                    return accountName;
                } else {
                    await vscode.window.showErrorMessage(`IoT Hub name '${accountName}' is not available.`);
                }
            } catch (error) {
                await vscode.window.showErrorMessage(error.message);
            }
        }
    }

    private validateIoTHubName(name: string): string {
        const min = 3;
        const max = 50;
        if (!name || name.length < min || name.length > max) {
            return `The name must be between ${min} and ${max} characters long.`;
        }
        if (name.match(/[^a-zA-Z0-9-]/)) {
            return "The name must contain only alphanumeric characters or -";
        }
        if (name.startsWith("-")) {
            return "The name must not start with -";
        }
        if (name.endsWith("-")) {
            return "The name must not end with -";
        }
        return null;
    }

    private async createResourceGroup(subscriptionItem: SubscriptionItem): Promise<ResourceModels.ResourceGroup> {
        const resourceGroupName = await vscode.window.showInputBox({
            placeHolder: "Resource Group Name",
            prompt: "Provide a resource group name",
            validateInput: this.validateResourceGroupName,
            ignoreFocusOut: true,
        });

        if (resourceGroupName) {
            const locationItem = await vscode.window.showQuickPick(
                this.getLocationItems(subscriptionItem),
                { placeHolder: "Select a location to create your Resource Group in...", ignoreFocusOut: true },
            );

            if (locationItem) {
                return vscode.window.withProgress({
                    title: `Creating resource group '${resourceGroupName}'`,
                    location: vscode.ProgressLocation.Window,
                }, async (progress) => {
                    const resourceManagementClient = new ResourceManagementClient(subscriptionItem.session.credentials, subscriptionItem.subscription.subscriptionId);
                    return resourceManagementClient.resourceGroups.createOrUpdate(resourceGroupName, { location: locationItem.location.name });
                });
            }
        }
        return null;
    }

    private validateResourceGroupName(name: string): string {
        const min = 1;
        const max = 90;
        if (!name || name.length < min || name.length > max) {
            return `The name must be between ${min} and ${max} characters long.`;
        }
        if (name.match(/[^a-zA-Z0-9\.\_\-\(\)]/)) {
            return "The name must contain only alphanumeric characters or the symbols ._-()";
        }
        if (name.endsWith(".")) {
            return "The name must not end in a period.";
        }
        return null;
    }
}

interface IPartialList<T> extends Array<T> {
    nextLink?: string;
}
