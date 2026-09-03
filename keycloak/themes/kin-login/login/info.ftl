<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
        <#if messageHeader??>
            ${kcSanitize(msg("${messageHeader}"))?no_esc}
        <#else>
            ${message.summary}
        </#if>
    <#elseif section = "form">
    <div id="kc-info-message">
        <p class="instruction">${message.summary}<#if requiredActions??><#list requiredActions>: <b><#items as reqActionItem>${kcSanitize(msg("requiredAction.${reqActionItem}"))?no_esc}<#sep>, </#items></b></#list></#if></p>
        <#if !(skipLink??) && pageRedirectUri?has_content>
            <p><a href="${pageRedirectUri}">${msg("backToApplication")}</a></p>
        <#elseif !(skipLink??) && actionUri?has_content>
            <p><a href="${actionUri}">${msg("proceedWithAction")}</a></p>
        <#elseif !(skipLink??) && (client.baseUrl)?has_content>
            <p><a href="${client.baseUrl}">${msg("backToApplication")}</a></p>
        <#else>
            <div id="kc-form-buttons" class="${properties.kcFormButtonsClass!}">
                <a id="kin-continue" class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" href="/api/auth/login">${msg("continueToKin")}</a>
            </div>
        </#if>
    </div>
    </#if>
</@layout.registrationLayout>
